/**
 * pi-auto-approve
 *
 * Auto-reviews bash commands by asking the **same model** to double-check
 * itself with **full conversation context** (cache-friendly).
 *
 * Three tiers:
 *   1. Auto-permitted — safe commands via regex (ls, cd, grep, etc.)
 *   2. Auto-blocked   — catastrophic operations via regex (rm -rf /, mkfs.)
 *   3. Self-review    — first-class cache: systemPrompt + sessionId + shared context
 *                       fed to completeSimple; same model, same prefix,
 *                       usually favoring prefix cache hit rates.
 *
 * Pass = TUI notify, no tool result pollution.
 * Block = reason sent back to model.
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message, TextContent } from "@earendil-works/pi-ai";

// ── Tier 1: Auto-permitted ──
export const AUTO_PERMITTED = [
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
];

// ── Tier 2: Auto-blocked ──
export const AUTO_BLOCKED = [
    /\brm\s+(-rf?|--recursive)\s+\/(?:\s|$)/,
    /\brm\s+(-rf?|--recursive)\s+\/etc\b/,
    /\brm\s+(-rf?|--recursive)\s+\/usr\b/,
    /\brm\s+(-rf?|--recursive)\s+\/var\b/,
    /:\(\)\s*\{/,
    /\bdd\s+if=\/dev/,
    /\bmkfs\./,
];

let autoApproveEnabled = true;

function formatCacheHitRate(usage: any): string | null {
    if (!usage) return null;
    const cacheRead = Number(usage.cacheRead ?? 0);
    const total = Number(usage.totalTokens ?? 0);
    if (!Number.isFinite(cacheRead) || !Number.isFinite(total) || total <= 0) return null;
    const cacheHit = total > 0 ? Math.round((cacheRead / total) * 1000) / 10 : 0;
    return `CH ${cacheHit}%`;
}

function formatReviewToast(reason: string, usage: any): string {
    const cache = formatCacheHitRate(usage);
    return cache ? `🛡️ ${reason} · ${cache}` : `🛡️ ${reason}`;
}

function shouldDebugReview(): boolean {
    return (globalThis as any).process?.env?.PI_AUTO_APPROVE_DEBUG_REVIEW === "1";
}

function getTextContent(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
        .filter((p): p is TextContent => p?.type === "text")
        .map((p) => p.text)
        .join("");
}

export function buildReviewPrompt(command: string): string {
    return [
        `You are an internal safety review module inserted at the end of the current conversation.`,
        `Main conversation is context only; do not continue user work.`,
        `Task: decide whether the following bash command should be allowed now.`,
        `Command: ${JSON.stringify(command)}`,
        `Decision rules:`,
        `- allow: read-only, low-risk, or explicitly authorized by the user`,
        `- block: destructive, secrets-related, writes/edits state without clear authorization, or unclear intent`,
        `Output format (exact JSON, no markdown, no tool call, no extra text):`,
        `- verdict must be "allow" or "block"`,
        `- reason should be a short phrase`,
        `Example:`,
        `{"verdict":"allow","reason":"read-only diagnostic command"}`,
    ].join("\n");
}

export function parseReviewResult(text: string): { allowed: boolean; reason: string } | null {
    const normalized = text.replace(/```json|```/gi, "").trim();
    const firstBrace = normalized.indexOf("{");
    const lastBrace = normalized.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) return null;

    let payload: unknown;
    try {
        payload = JSON.parse(normalized.slice(firstBrace, lastBrace + 1));
    } catch {
        return null;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

    const typedPayload = payload as Record<string, unknown>;
    const reasonRaw = typeof typedPayload.reason === "string" ? typedPayload.reason : "";
    const reason = reasonRaw.trim();

    const verdictValue = typeof typedPayload.verdict === "string" ? typedPayload.verdict.trim().toLowerCase() : "";
    const allowed =
        verdictValue === "allow" ? true :
            verdictValue === "block" ? false :
                null;
    if (allowed === null) return null;
    if (!reason) return null;

    return { allowed, reason };
}

export function buildReviewContext(
    sessionManager: { getBranch(): Array<{ type: string; message: { role: string; content: unknown } }> },
    systemPrompt: string | undefined,
    command: string,
): { systemPrompt?: string; messages: Message[] } {
    const messages: Message[] = [];
    for (const entry of sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message as Message;
        // Spread the entire message to keep the prefix byte-identical to the main
        // conversation — this maximizes KV prefix cache hit rate.  Dropping any
        // field (e.g. toolCallId, toolName, isError, timestamp) would both break
        // the API serialisation and cause a cache miss.
        messages.push({ ...msg });
    }
    messages.push({
        role: "user",
        content: [{ type: "text" as const, text: buildReviewPrompt(command) }],
    });
    return { systemPrompt, messages };
}

export function getModelRef(model: { provider?: string; id?: string } | undefined): string {
    if (!model?.provider || !model?.id) return "unknown";
    return `${model.provider}/${model.id}`;
}

export function resolveReviewModel<T extends { provider?: string; id?: string }>(
    modelRegistry: { find(provider: string, id: string): T | undefined },
    model: T,
): T {
    if (!model.provider || !model.id) return model;
    return modelRegistry.find(model.provider, model.id) ?? model;
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("autoapprove", {
        description: "Toggle auto-approve on/off",
        handler: async (_args, ctx) => {
            autoApproveEnabled = !autoApproveEnabled;
            ctx.ui.notify(`auto-approve: ${autoApproveEnabled ? "on" : "off"}`, "info");
        },
    });

    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return undefined;
        if (!autoApproveEnabled) return undefined;

        const command = (event.input.command as string).trim();
        if (!command) return undefined;

        for (const pattern of AUTO_BLOCKED) {
            if (pattern.test(command)) {
                return { block: true, reason: `Auto-blocked: ${pattern.source}` };
            }
        }

        for (const pattern of AUTO_PERMITTED) {
            if (pattern.test(command)) {
                return undefined;
            }
        }

        if (!ctx.hasUI || !ctx.model || !ctx.modelRegistry) {
            return { block: true, reason: "Requires review (non-interactive mode)" };
        }

        try {
            const reviewModel = resolveReviewModel(ctx.modelRegistry, ctx.model);
            if (!reviewModel.provider || !reviewModel.id) {
                return { block: true, reason: "Review model is unavailable" };
            }

            const { systemPrompt, messages } = buildReviewContext(ctx.sessionManager, ctx.getSystemPrompt(), command);
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(reviewModel);
            if (!auth?.ok) {
                const error = auth?.error ? `: ${auth.error}` : "";
                ctx.ui.notify(`🚫 Review auth failed for ${getModelRef(reviewModel)}${error}`, "warning");
                return { block: true, reason: `Review auth failed for ${getModelRef(reviewModel)}` };
            }

            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Review timed out")), 30000)
            );

            const sessionId = ctx.sessionManager.getSessionId();
            const completeReview = async (reviewMessages: Message[]) => {
                const options: any = {
                    apiKey: auth?.apiKey,
                    env: auth?.env,
                    headers: auth?.headers,
                    cacheRetention: "short",
                    sessionId,
                    signal: ctx.signal,
                    maxTokens: 160,
                };
                return await Promise.race([
                    completeSimple(reviewModel, { systemPrompt, messages: reviewMessages }, options),
                    timeoutPromise,
                ]);
            };

            let msg: any = null;
            try {
                msg = await completeReview(messages);
            } catch {
                // Review timed out (30s) — fail open but tell the user via toast
                ctx.ui.notify(`⏱ Review timed out — allowed: ${command.slice(0, 80)}`, "warning");
                return undefined;
            }

            if (msg?.stopReason === "error") {
                const em = msg?.errorMessage ? ` (${msg.errorMessage})` : '';
                ctx.ui.notify(`⚠ Review error — allowed: ${command.slice(0, 60)}${em}`, "warning");
                return undefined;
            }

            const text = getTextContent(msg.content);
            let decision = text ? parseReviewResult(text) : null;
            if (!decision) {
                const reason = "Review did not return valid structured verdict";
                if (shouldDebugReview()) {
                    ctx.ui.notify(`⚠ Raw review: ${(text || JSON.stringify(msg?.content ?? [])).slice(0, 220)}`, "warning");
                }
                ctx.ui.notify(formatReviewToast(`Blocked: ${reason}`, msg?.usage), "warning");
                return { block: true, reason };
            }

            if (decision.allowed) {
                // Allowed: toast only, never inject into tool result (no context pollution)
                ctx.ui.notify(formatReviewToast(decision.reason, msg?.usage), "info");
                return undefined;
            }
            ctx.ui.notify(formatReviewToast(`Blocked: ${decision.reason}`, msg?.usage), "warning");
            return { block: true, reason: `${decision.reason}` };
        } catch {
            ctx.ui.notify(`⚠ Review error — allowed: ${command.slice(0, 80)}`, "warning");
            return undefined;
        }
    });
}
