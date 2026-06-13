/**
 * pi-auto-approve
 *
 * Auto-reviews bash commands by asking the **same model** to double-check
 * itself with **full conversation context** (forked context, cache-friendly).
 *
 * Three tiers:
 *   1. Auto-permitted — safe commands (ls, cd, grep, etc.)
 *   2. Auto-blocked   — catastrophic operations (rm -rf /, mkfs.)
 *   3. Self-review    — fork conversation, inject review prompt,
 *                       model responds via tool call (structured output)
 *
 * The review result is injected into the tool output so it appears
 * in the conversation history — no separate notifications.
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ── Review tool definition ──
// The model MUST call this tool to report its review decision.
const reviewTool: Tool = {
    name: "auto_approve_result",
    description: "Report the auto-approve review decision for the bash command",
    parameters: Type.Object({
        verdict: Type.Union(
            [Type.Literal("allow"), Type.Literal("block")],
            { description: "allow = safe to run, block = risky or unauthorized" },
        ),
        reason: Type.String({ description: "Brief explanation of the decision" }),
    }),
};

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

// ── Tier 2: Auto-blocked ──
const AUTO_BLOCKED = [
    /\brm\s+(-rf?|--recursive)\s+\/\b/,
    /\brm\s+(-rf?|--recursive)\s+\/etc\b/,
    /\brm\s+(-rf?|--recursive)\s+\/usr\b/,
    /\brm\s+(-rf?|--recursive)\s+\/var\b/,
    /:\(\)\s*\{/,
    /\bdd\s+if=\/dev/,
    /\bmkfs\./,
    />\s*\/dev\//,
];

// ── Staging area: decisions to inject into tool results ──
const toolCallDecisions = new Map<string, string>();

// ── Review prompt (XML tags, tool-based response) ──
function buildReviewPrompt(command: string): string {
    return [
        `<auto-approve>`,
        `  <command>${command}</command>`,
        `</auto-approve>`,
        ``,
        `Review this command against the conversation context.`,
        `Call the "auto_approve_result" tool with your verdict.`,
    ].join("\n");
}

// ── Build conversation context ──
function buildReviewContext(
    sessionManager: { getBranch(): Array<{ type: string; message: { role: string; content: unknown } }> },
    command: string,
): { messages: Message[]; tools: Tool[] } {
    const messages: Message[] = [];
    for (const entry of sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role === "user" || msg.role === "assistant") {
            messages.push({ role: msg.role, content: msg.content as Message["content"] });
        }
    }
    messages.push({
        role: "user",
        content: [{ type: "text", text: buildReviewPrompt(command) }],
    });
    return { messages, tools: [reviewTool] };
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return undefined;

        const command = (event.input.command as string).trim();
        if (!command) return undefined;

        // Tier 2: Auto-block
        for (const pattern of AUTO_BLOCKED) {
            if (pattern.test(command)) {
                return { block: true, reason: `🛡️ Auto-blocked: ${pattern.source}` };
            }
        }

        // Tier 1: Auto-permitted
        for (const pattern of AUTO_PERMITTED) {
            if (pattern.test(command)) {
                return undefined;
            }
        }

        // Tier 3: Self-review
        if (!ctx.hasUI || !ctx.model || !ctx.modelRegistry) {
            return { block: true, reason: "🛡️ Requires review (non-interactive mode)" };
        }

        ctx.ui.setStatus("auto-approve", `Reviewing: ${command.slice(0, 60)}...`);

        try {
            const { messages, tools } = buildReviewContext(ctx.sessionManager, command);
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);

            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Review timed out")), 30000)
            );

            interface ReviewResult { verdict: string; reason: string }
            let fullMsg: any = null;
            const reviewPromise = complete(ctx.model, {
                messages,
                tools,
            }, {
                apiKey: auth.ok ? auth.apiKey : undefined,
            }).then((msg) => {
                fullMsg = msg;
                for (const block of msg.content) {
                    if (block.type === "toolCall" && block.name === "auto_approve_result") {
                        return block.arguments as ReviewResult;
                    }
                }
                return null;
            });

            let result: ReviewResult | null;
            try {
                result = await Promise.race([reviewPromise, timeoutPromise]);
            } catch {
                ctx.ui.setStatus("auto-approve", undefined);
                toolCallDecisions.set(event.toolCallId, "🛡️ Review timed out — allowed");
                return undefined;
            }

            ctx.ui.setStatus("auto-approve", undefined);

            if (!result) {
                const types = (fullMsg?.content ?? []).map((b: any) => b.type).join(",");
                const snippet = JSON.stringify((fullMsg?.content ?? []).slice(0, 3)).slice(0, 400);
                toolCallDecisions.set(event.toolCallId, `🛡️ Review unclear (${types}) — allowed ${snippet}`);
                return undefined;
            }

            if (result.verdict === "allow") {
                toolCallDecisions.set(event.toolCallId, `🛡️ ${result.reason}`);
                return undefined;
            } else {
                return { block: true, reason: `🛡️ ${result.reason}` };
            }
        } catch {
            ctx.ui.setStatus("auto-approve", undefined);
            toolCallDecisions.set(event.toolCallId, "🛡️ Review error — allowed");
            return undefined;
        }
    });

    // ── Inject approval note into tool result ──
    pi.on("tool_result", async (event) => {
        const note = toolCallDecisions.get(event.toolCallId);
        if (!note) return;
        toolCallDecisions.delete(event.toolCallId);
        return {
            content: [{ type: "text" as const, text: note + "\n" }, ...(event.content ?? [])],
        };
    });
}
