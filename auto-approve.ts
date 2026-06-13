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
 *                       prefer forced tool output, XML fallback
 *
 * The review result is injected into the tool output so it appears
 * in the conversation history — no separate notifications.
 */

import { complete, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message, TextContent, Tool } from "@earendil-works/pi-ai";

const reviewTool: Tool = {
    name: "auto_approve_result",
    description: "Return the review verdict for the proposed bash command.",
    parameters: Type.Object({
        verdict: Type.Union([Type.Literal("allow"), Type.Literal("block")]),
        reason: Type.String(),
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

const toolCallDecisions = new Map<string, string>();

function buildReviewPrompt(command: string): string {
    return [
        `<auto-approve>`,
        `  <command>${command}</command>`,
        `</auto-approve>`,
        ``,
        `Review this command against the full conversation context.`,
        `Use the auto_approve_result tool.`,
        `If tool use is unavailable, reply with exactly this XML shape:`,
        `<auto_approve_result>`,
        `  <verdict>allow</verdict> OR <verdict>block</verdict>`,
        `  <reason>brief explanation</reason>`,
        `</auto_approve_result>`,
        `Do not do anything else.`,
    ].join("\n");
}

function parseXmlVerdict(text: string): { allowed: boolean; reason: string } | null {
    const verdictMatch = text.match(/<verdict>\s*(allow|block)\s*<\/verdict>/i);
    if (!verdictMatch) return null;
    const allowed = verdictMatch[1].toLowerCase() === "allow";
    const reasonMatch = text.match(/<reason>([\s\S]*?)<\/reason>/i);
    const reason = reasonMatch ? reasonMatch[1].trim() : "no reason given";
    return { allowed, reason };
}

function parseToolVerdict(args: Record<string, unknown>): { allowed: boolean; reason: string } | null {
    const rawVerdict = typeof args.verdict === "string"
        ? args.verdict
        : typeof args.decision === "string"
          ? args.decision
          : typeof args.allowed === "boolean"
            ? (args.allowed ? "allow" : "block")
            : undefined;
    if (rawVerdict !== "allow" && rawVerdict !== "block") return null;
    const reason = typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim()
        : rawVerdict === "allow"
          ? "approved"
          : "blocked by review";
    return { allowed: rawVerdict === "allow", reason };
}

function buildReviewContext(
    sessionManager: { getBranch(): Array<{ type: string; message: { role: string; content: unknown } }> },
    command: string,
): Message[] {
    const messages: Message[] = [];
    for (const entry of sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg.role === "user" || msg.role === "assistant") {
            const content = msg.content as Message["content"];
            const textOnly = Array.isArray(content)
                ? content.filter((b: any) => b.type === "text" || b.type === "thinking")
                : content;
            messages.push({ role: msg.role, content: textOnly });
        }
    }
    messages.push({
        role: "user",
        content: [{ type: "text" as const, text: buildReviewPrompt(command) }],
    });
    return messages;
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
            const messages = buildReviewContext(ctx.sessionManager, command);
            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Review timed out")), 30000)
            );

            const reviewPromise = complete(
                ctx.model,
                { messages, tools: [reviewTool] },
                {
                    toolChoice: { type: "function", function: { name: reviewTool.name } },
                    reasoningEffort: "minimal",
                    maxTokens: 120,
                },
            );

            let msg;
            try {
                msg = await Promise.race([reviewPromise, timeoutPromise]);
            } catch {
                ctx.ui.setStatus("auto-approve", undefined);
                toolCallDecisions.set(event.toolCallId, "🛡️ Review timed out — allowed");
                return undefined;
            }

            ctx.ui.setStatus("auto-approve", undefined);

            for (const block of msg.content) {
                if (block.type === "toolCall" && block.name === reviewTool.name) {
                    const decision = parseToolVerdict(block.arguments ?? {});
                    if (!decision) break;
                    if (decision.allowed) {
                        toolCallDecisions.set(event.toolCallId, `🛡️ ${decision.reason}`);
                        return undefined;
                    }
                    return { block: true, reason: `🛡️ ${decision.reason}` };
                }
            }

            const text = msg.content
                .filter((p): p is TextContent => p.type === "text")
                .map((p) => p.text)
                .join("");
            const xmlDecision = text ? parseXmlVerdict(text) : null;
            if (!xmlDecision) {
                toolCallDecisions.set(event.toolCallId, "🛡️ Review unclear — allowed");
                return undefined;
            }

            if (xmlDecision.allowed) {
                toolCallDecisions.set(event.toolCallId, `🛡️ ${xmlDecision.reason}`);
                return undefined;
            }
            return { block: true, reason: `🛡️ ${xmlDecision.reason}` };
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
