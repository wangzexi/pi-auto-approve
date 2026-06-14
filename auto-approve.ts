/**
 * pi-auto-approve
 *
 * Auto-reviews bash commands by asking the **same model** to double-check
 * itself with **full conversation context** (forked context, cache-friendly).
 *
 * Three tiers:
 *   1. Auto-permitted — safe commands via regex (ls, cd, grep, etc.)
 *   2. Auto-blocked   — catastrophic operations via regex (rm -rf /, mkfs.)
 *   3. Self-review    — fork conversation, inject review prompt,
 *                       model responds with XML verdict tags
 *
 * The review result is injected into the tool output so it appears
 * in the conversation history — no separate notifications.
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message, TextContent, Tool } from "@earendil-works/pi-ai";

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
    /\brm\s+(-rf?|--recursive)\s+\/(?:\s|$)/,
    /\brm\s+(-rf?|--recursive)\s+\/etc\b/,
    /\brm\s+(-rf?|--recursive)\s+\/usr\b/,
    /\brm\s+(-rf?|--recursive)\s+\/var\b/,
    /:\(\)\s*\{/,
    /\bdd\s+if=\/dev/,
    /\bmkfs\./,
];

const toolCallDecisions = new Map<string, string>();

function buildReviewPrompt(command: string): string {
    return [
        `<auto-approve>`,
        `<auto-approve>`,
        `  <command>${command}</command>`,
        `</auto-approve>`,
        ``,
        `Review this command against the full conversation context.`,
        `Reply with EXACTLY this XML shape and nothing else: No markdown, no prose.`,
        `<auto_approve_result>`,
        `  <verdict>allow</verdict> OR <verdict>block</verdict>`,
        `  <reason>one short phrase, 3-8 words</reason>`,
        `</auto_approve_result>`,
    ].join("\n");
}

function parseXmlVerdict(text: string): { allowed: boolean; reason: string } | null {
    const normalized = text
        .replace(/```xml|```/gi, "")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");

    const verdictPatterns = [
        /<(?:verdict|decision|result)>\s*([\s\S]*?)\s*<\/(?:verdict|decision|result)>/i,
        /<(?:auto_approve_result|review_result)[^>]*\sverdict=["']([^"']+)["'][^>]*>/i,
    ];
    const verdictRaw = verdictPatterns
        .map((pattern) => normalized.match(pattern)?.[1]?.trim())
        .find(Boolean)
        ?.toLowerCase();

    if (!verdictRaw) return null;

    const allowWords = ["allow", "approve", "approved", "confirm", "confirmed", "yes", "safe", "ok"];
    const blockWords = ["block", "reject", "rejected", "deny", "denied", "no", "unsafe"];

    const allowed = allowWords.some((word) => verdictRaw.includes(word))
        ? true
        : blockWords.some((word) => verdictRaw.includes(word))
          ? false
          : null;
    if (allowed === null) return null;

    const reasonPatterns = [
        /<(?:reason|note|why)>\s*([\s\S]*?)\s*<\/(?:reason|note|why)>/i,
        /<(?:auto_approve_result|review_result)[^>]*\sreason=["']([^"']+)["'][^>]*>/i,
    ];
    const reason = reasonPatterns
        .map((pattern) => normalized.match(pattern)?.[1]?.trim())
        .find(Boolean) || (allowed ? "approved" : "blocked by review");

    return { allowed, reason };
}

function buildReviewContext(
    sessionManager: { getBranch(): Array<{ type: string; message: { role: string; content: unknown } }> },
    systemPrompt: string | undefined,
    command: string,
): { systemPrompt?: string; messages: Message[] } {
    const messages: Message[] = [];
    for (const entry of sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message as Message;
        // Include ALL roles (user, assistant, toolResult) to keep prefix identical
        // and ALL content types so provider's prefix cache matches the main conversation
        messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({
        role: "user",
        content: [{ type: "text" as const, text: buildReviewPrompt(command) }],
    });
    return { systemPrompt, messages };
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return undefined;

        const command = (event.input.command as string).trim();
        if (!command) return undefined;

        for (const pattern of AUTO_BLOCKED) {
            if (pattern.test(command)) {
                return { block: true, reason: `🛡️ Auto-blocked: ${pattern.source}` };
            }
        }

        for (const pattern of AUTO_PERMITTED) {
            if (pattern.test(command)) {
                return undefined;
            }
        }

        if (!ctx.hasUI || !ctx.model || !ctx.modelRegistry) {
            return { block: true, reason: "🛡️ Requires review (non-interactive mode)" };
        }

        ctx.ui.setStatus("auto-approve", `Reviewing: ${command.slice(0, 60)}...`);

        try {
            const { systemPrompt, messages } = buildReviewContext(ctx.sessionManager, ctx.getSystemPrompt(), command);
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
            const timeoutPromise = new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error("Review timed out")), 30000)
            );

            const sessionId = ctx.sessionManager.getSessionId();
            // Build context matching main conversation: include active tool definitions for cache affinity
            const activeToolNames = pi.getActiveTools();
            const allTools = pi.getAllTools();
            const tools: Tool[] = allTools
                .filter((t) => activeToolNames.includes(t.name))
                .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
            const reasoningCandidates: Array<"minimal" | "low" | undefined> = ["minimal", "low", undefined];
            let msg: any = null;
            try {
                for (const reasoning of reasoningCandidates) {
                    const options: any = {
                        apiKey: auth?.apiKey,
                        headers: auth?.headers,
                        cacheRetention: "short",
                        sessionId,
                    };
                    if (reasoning) options.reasoning = reasoning;
                    msg = await Promise.race([completeSimple(ctx.model, { systemPrompt, messages, tools }, options), timeoutPromise]);
                    const errorMessage = String(msg?.errorMessage || "");
                    if (msg?.stopReason !== "error") break;
                    if (!/unsupported value|not supported/i.test(errorMessage)) break;
                }
            } catch {
                ctx.ui.setStatus("auto-approve", undefined);
                toolCallDecisions.set(event.toolCallId, "🛡️ Review timed out — allowed");
                return undefined;
            }

            ctx.ui.setStatus("auto-approve", undefined);

            if (msg?.stopReason === "error") {
                toolCallDecisions.set(event.toolCallId, "🛡️ Review error — allowed");
                return undefined;
            }

            const text = msg.content
                .filter((p): p is TextContent => p.type === "text")
                .map((p) => p.text)
                .join("");
            const decision = text ? parseXmlVerdict(text) : null;
            if (!decision) {
                toolCallDecisions.set(event.toolCallId, "🛡️ Review unclear — allowed");
                return undefined;
            }

            if (decision.allowed) {
                // Allowed: no injection needed, model's own response suffices
                return undefined;
            }
            return { block: true, reason: `🛡️ ${decision.reason}` };
        } catch {
            ctx.ui.setStatus("auto-approve", undefined);
            toolCallDecisions.set(event.toolCallId, "🛡️ Review error — allowed");
            return undefined;
        }
    });

    pi.on("tool_result", async (event) => {
        const note = toolCallDecisions.get(event.toolCallId);
        if (!note) return;
        toolCallDecisions.delete(event.toolCallId);
        return {
            content: [{ type: "text" as const, text: note + "\n" }, ...(event.content ?? [])],
        };
    });
}
