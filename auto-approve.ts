/**
 * pi-auto-approve
 *
 * Auto-reviews bash commands by asking the **same model** to double-check
 * itself with **full conversation context** (forked context, cache-friendly).
 *
 * Three tiers:
 *   1. Auto-permitted — safe commands (ls, cd, grep, git status, etc.)
 *   2. Auto-blocked   — catastrophic operations (rm -rf /, dd if=, mkfs.)
 *   3. Self-review    — everything else: inject a review message into the
 *                       existing conversation, let the model reconsider.
 */

import { completeSimple } from "@earendil-works/pi-ai";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message, TextContent } from "@earendil-works/pi-ai";

// ── Tier 1: Auto-permitted ──
const AUTO_PERMITTED = [
    /^(ls|dir|tree)\b/,
    /^cd\b/,
    /^(cat|head|tail|less|more)\b/,
    /^(file|stat|wc|du|df)\b/,
    /^(grep|rg|ag|ack)\b/,
    /^(find|locate|which|whereis|type)\b/,
    /^git\s+(status|log|diff|show|branch|tag|stash\s+list|remote|ls-remote|rev-parse|rev-list|describe|whatchanged|shortlog|blame|grep|config\s+--get|config\s+--list|config\s+-l)\b/,
    /^git\s+log\b/,
    /^(docker|podman)\s+(ps|images|inspect|logs|stats|info|version|history|top|diff)\b/,
    /^(npm|yarn|pnpm)\s+(list|info|view|outdated|audit|why|config\s+list)\b/,
    /^(pip|pip3)\s+(list|show|freeze|search)\b/,
    /^(cargo|go)\s+(search|doc)\b/,
    /^(echo|printenv|env|whoami|hostname|uname|uptime|id|groups|pwd|date)\b/,
    /^(python3?|node|uv|tsx|npx)\s+(--version|-v|--help|-h)$/,
    /^.*\s+(--help|-h)\s*$/,
    /^echo\s/,
    /^pwd\b/,
];

// ── Tier 2: Auto-blocked (truly catastrophic only) ──
const AUTO_BLOCKED = [
    /\brm\s+(-rf?|--recursive)\s+\/\b/,          // rm -rf /
    /\brm\s+(-rf?|--recursive)\s+\/etc\b/,       // rm -rf /etc
    /\brm\s+(-rf?|--recursive)\s+\/usr\b/,       // rm -rf /usr
    /\brm\s+(-rf?|--recursive)\s+\/var\b/,       // rm -rf /var
    /:\(\)\s*\{/,                                  // fork bomb
    /\bdd\s+if=\/dev/,                            // dd if=/dev/...
    /\bmkfs\./,                                    // format disk
    />\s*\/dev\//,                                 // write to device
];

// ── Review prompt (injected into existing conversation) ──
function buildReviewPrompt(command: string): string {
    return `🔍 **Double-check before running this command**

\`\`\`bash
${command}
\`\`\`

Take another look. In the context of what we've been discussing:

1. Is this command **safe and appropriate** for what we need to do?
2. Could this be a **command injection**, destructive operation, or security risk?
3. Could it **accidentally delete important files** or affect system stability?
4. Is there a **safer alternative**?

Think carefully with the full conversation in mind.

- If you're **confident** it's correct → reply: \`CONFIRM: <brief reason>\`
- If it's **risky or wrong** → reply: \`REJECT: <reason>\` and suggest a safer alternative

**Do not run any tools.** Just think and respond.`;
}

// ── Build conversation context from current session ──
// Scans session entries, extracts user/assistant messages,
// then appends a review prompt asking the model to double-check.
function buildReviewContext(
    sessionManager: { getBranch(): Array<{ type: string; message: { role: string; content: unknown } }> },
    command: string,
): Message[] {
    const messages: Message[] = [];
    for (const entry of sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role === "user" || msg.role === "assistant") {
            messages.push({ role: msg.role, content: msg.content as Message["content"] });
        }
        // Skip toolResult — too verbose, model remembers what it did
    }
    // Append the review prompt
    messages.push({
        role: "user",
        content: [{ type: "text", text: buildReviewPrompt(command) }],
    });
    return messages;
}

// ── Parse CONFIRM / REJECT ──
function parseDecision(text: string): { allowed: boolean; reason: string } | null {
    const confirmMatch = text.match(/^CONFIRM:\s*(.+)/im);
    if (confirmMatch) return { allowed: true, reason: confirmMatch[1].trim() };
    const rejectMatch = text.match(/^REJECT:\s*(.+)/im);
    if (rejectMatch) return { allowed: false, reason: rejectMatch[1].trim() };
    return null;
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return undefined;

        const command = (event.input.command as string).trim();
        if (!command) return undefined;

        // Tier 2: Auto-block (catastrophic only)
        for (const pattern of AUTO_BLOCKED) {
            if (pattern.test(command)) {
                return { block: true, reason: `Auto-blocked: catastrophic command "${pattern.source}"` };
            }
        }

        // Tier 1: Auto-permitted
        for (const pattern of AUTO_PERMITTED) {
            if (pattern.test(command)) {
                return undefined;
            }
        }

        // Tier 3: Self-review — fork context, ask model to reconsider
        if (!ctx.hasUI) {
            return { block: true, reason: "Command requires review but no UI available" };
        }

        if (!ctx.model || !ctx.modelRegistry) {
            return { block: true, reason: "No model available for review" };
        }

        ctx.ui.setStatus("auto-approve", `Reviewing: ${command.slice(0, 60)}...`);

        try {
            // 1. Build review context from the current conversation
            const reviewCtx = buildReviewContext(ctx.sessionManager, command);

            // 2. Get API key for the current model
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);

            // 3. Timeout
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), 15000);
            if (ctx.signal) {
                if (ctx.signal.aborted) {
                    clearTimeout(timer);
                    return { block: true, reason: "Review aborted" };
                }
                ctx.signal.addEventListener("abort", () => {
                    clearTimeout(timer);
                    abort.abort();
                }, { once: true });
            }

            let decision: { allowed: boolean; reason: string } | null = null;
            try {
                const message = await completeSimple(ctx.model, { messages: reviewCtx }, {
                    apiKey: auth.ok ? auth.apiKey : undefined,
                    signal: abort.signal,
                });

                const text = message.content
                    .filter((p): p is TextContent => p.type === "text")
                    .map((p) => p.text)
                    .join("");

                decision = text ? parseDecision(text) : null;
            } finally {
                clearTimeout(timer);
            }

            ctx.ui.setStatus("auto-approve", undefined);

            if (!decision) {
                // Fallback: ask user
                const choice = await ctx.ui.select(
                    `⚠️  Auto-approve: unclear response\n\nCommand: ${command}\n\nAllow?`,
                    ["Yes", "No"],
                );
                if (choice !== "Yes") {
                    return { block: true, reason: "Auto-approve: user declined" };
                }
                return undefined;
            }

            if (decision.allowed) {
                ctx.ui.notify(`Auto-approve: ✓ ${decision.reason}`, "info");
                return undefined;
            } else {
                ctx.ui.notify(`Auto-approve: ✗ ${decision.reason}`, "warning");
                return { block: true, reason: `Auto-approve: ${decision.reason}` };
            }
        } catch (err) {
            ctx.ui.setStatus("auto-approve", undefined);
            const msg = err instanceof Error ? err.message : String(err);
            const choice = await ctx.ui.select(
                `⚠️  Auto-approve failed: ${msg}\n\nCommand: ${command}\n\nAllow?`,
                ["Yes", "No"],
            );
            if (choice !== "Yes") {
                return { block: true, reason: "Auto-approve failed and user declined" };
            }
            return undefined;
        }
    });
}
