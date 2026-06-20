/**
 * pi-auto-approve
 *
 * Auto-reviews bash commands by asking the **same model** to double-check
 * itself with **full conversation context** (cache-friendly).
 *
 * Three tiers:
 *   1. Auto-permitted — safe commands via regex (ls, cd, grep, etc.)
 *   2. Auto-blocked   — catastrophic operations via regex (rm -rf /, mkfs.)
 *   3. Self-review    — first-class cache: sessionId + shared context + bounded user
 *                       safety envelope fed to completeSimple; same model/prefix
 *                       segments, favoring cache hit rates when commands repeat.
 *
 * Pass = TUI notify, no tool result pollution.
 * Block = reason sent back to model.
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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
const REVIEW_LOG_PATH = join(homedir(), ".pi", "agent", "pi-auto-approve.log");

function formatCacheHitRate(usage: any): string | null {
    if (!usage) return null;
    const cacheRead = Number(usage.cacheRead ?? 0);
    const input = Number(usage.input ?? usage.inputTokens ?? 0);
    const promptTotal = cacheRead + input;
    if (!Number.isFinite(cacheRead) || !Number.isFinite(input) || promptTotal <= 0) return null;
    const cacheHit = Math.round((cacheRead / promptTotal) * 1000) / 10;
    return `CH ${cacheHit}%`;
}

function formatTotalCacheShare(usage: any): string | null {
    if (!usage) return null;
    const cacheRead = Number(usage.cacheRead ?? 0);
    const total = Number(usage.totalTokens ?? 0);
    if (!Number.isFinite(cacheRead) || !Number.isFinite(total) || total <= 0) return null;
    const cacheHit = Math.round((cacheRead / total) * 1000) / 10;
    return `totalCH=${cacheHit}%`;
}

function formatReviewToast(reason: string, usage: any): string {
    const usageSummary = formatUsageSummary(usage);
    return usageSummary ? `🕵️ ${reason} · ${usageSummary}` : `🕵️ ${reason}`;
}

function shouldDebugReview(): boolean {
    return (globalThis as any).process?.env?.PI_AUTO_APPROVE_DEBUG_REVIEW === "1";
}

function getUsageCount(usage: any, ...keys: string[]): string {
    const raw = keys.map((key) => usage?.[key]).find((value) => value !== undefined);
    const value = Number(raw);
    return Number.isFinite(value) ? Math.round(value).toString() : "N/A";
}

function formatUsageSummary(usage: any): string | null {
    if (!usage) return null;
    const cache = formatCacheHitRate(usage) ?? "CH N/A";
    const totalCache = formatTotalCacheShare(usage) ?? "totalCH=N/A";
    const input = getUsageCount(usage, "input", "inputTokens");
    const output = getUsageCount(usage, "output", "outputTokens");
    const cacheRead = getUsageCount(usage, "cacheRead");
    const total = getUsageCount(usage, "totalTokens");
    return `${cache} | ${totalCache} | input=${input} | output=${output} | cacheRead=${cacheRead} | total=${total}`;
}

function getTextContent(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
        .filter((p): p is TextContent => p?.type === "text")
        .map((p) => p.text)
        .join("");
}

function writeReviewLog(entry: Record<string, unknown>): void {
    try {
        mkdirSync(dirname(REVIEW_LOG_PATH), { recursive: true });
        appendFileSync(REVIEW_LOG_PATH, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, "utf8");
    } catch {
        // Debug logging must never affect command approval behavior.
    }
}

function toCdata(value: string): string {
    return value.replaceAll("]]>", "]]]]><![CDATA[>");
}

function sanitizeMessageForReview(message: Message): Message | null {
    if (message.role === "toolResult") return null;
    if (message.role === "user") return { ...message };
    if (message.role !== "assistant") return { ...message };
    if (!Array.isArray(message.content)) return { ...message };

    const content = message.content.filter((part) => part?.type === "text" || part?.type === "thinking");
    if (content.length === 0) return null;
    return { ...message, content } as Message;
}

export function buildReviewPrompt(command: string): string {
    return [
        "<safety_review>",
        `  <request>`,
        `    <instruction>`,
        `      For this completion only, stop continuing the user's task and act as an internal security reviewer.`,
        `      The bash tool call has already been proposed by the assistant. Your only job is to review that proposed command.`,
        `      Do not execute, continue, rewrite, or plan any tool call from the conversation.`,
        `    </instruction>`,
        `    <rules>`,
        `      <allow>read-only, low-risk, or explicitly requested by the user in the current task</allow>`,
        `      <allow>public network diagnostics requested by the user, such as IP lookup, DNS lookup, or HTTP connectivity checks</allow>`,
        `      <block>destructive, secrets-related, credential exfiltration, private-file exfiltration, state-changing without clear authorization, or ambiguous</block>`,
        `    </rules>`,
        `    <output_contract>`,
        `      Return a JSON object with exactly these fields:`,
        `      {"verdict":"allow"|"block","reason":"..."}`,
        `      No markdown, no XML, no DSML, no tool call, no extra text.`,
        `    </output_contract>`,
        `    <example>{"verdict":"allow","reason":"read-only diagnostic command"}</example>`,
        `    <command><![CDATA[${toCdata(command)}]]></command>`,
        `  </request>`,
        `</safety_review>`,
    ].join("\n");
}

export function buildReviewContext(
    sessionManager: { getBranch(): Array<{ type: string; message: { role: string; content: unknown } }> },
    systemPrompt: string | undefined,
    command: string,
): { systemPrompt?: string; messages: Message[]; droppedToolTraceMessages: number } {
    const messages: Message[] = [];
    let droppedToolTraceMessages = 0;
    for (const entry of sessionManager.getBranch()) {
        if (entry.type !== "message") continue;
        const msg = entry.message as Message;
        const sanitized = sanitizeMessageForReview(msg);
        if (!sanitized) {
            droppedToolTraceMessages++;
            continue;
        }
        // Keep textual conversation context, but remove tool-call transcript
        // messages so the reviewer does not continue the main tool sequence.
        messages.push(sanitized);
    }
    messages.push({
        role: "user",
        content: [{ type: "text" as const, text: buildReviewPrompt(command) }],
    });
    return { systemPrompt, messages, droppedToolTraceMessages };
}

export function parseReviewResult(text: string): { allowed: boolean; reason: string } | null {
    const normalized = text.replace(/```(?:json)?/gi, "```").trim();
    const payloadText = extractFirstJsonObject(normalized);
    if (!payloadText) return null;

    let payload: unknown;
    try {
        payload = JSON.parse(payloadText);
    } catch {
        return null;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

    const typedPayload = payload as Record<string, unknown>;
    const keys = Object.keys(typedPayload).sort();
    if (keys.length !== 2 || keys[0] !== "reason" || keys[1] !== "verdict") return null;

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

function extractFirstJsonObject(text: string): string | null {
    for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < text.length; index++) {
            const char = text[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === "\\") {
                    escaped = true;
                } else if (char === "\"") {
                    inString = false;
                }
                continue;
            }
            if (char === "\"") {
                inString = true;
                continue;
            }
            if (char === "{") {
                depth++;
            } else if (char === "}") {
                depth--;
                if (depth === 0) return text.slice(start, index + 1);
            }
        }
    }
    return null;
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

            const { systemPrompt, messages, droppedToolTraceMessages } = buildReviewContext(ctx.sessionManager, ctx.getSystemPrompt(), command);
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
                    temperature: 0,
                    maxTokens: 80,
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
                writeReviewLog({
                    event: "timeout",
                    command,
                    model: getModelRef(reviewModel),
                    sessionId,
                    messageCount: messages.length,
                    systemPromptLength: systemPrompt?.length ?? 0,
                    droppedToolTraceMessages,
                });
                ctx.ui.notify(`⏱ Review timed out — allowed: ${command.slice(0, 80)}`, "warning");
                return undefined;
            }

            const lastReviewInput = messages[messages.length - 1]?.content as unknown;
            const reviewInput = Array.isArray(lastReviewInput)
                ? lastReviewInput
                    .filter((p): p is TextContent => p?.type === "text")
                    .map((p) => p.text)
                    .join("")
                : "";
            const reviewOutput = getTextContent(msg?.content);
            const ch = formatCacheHitRate(msg?.usage) ?? "N/A";
            const inputTextCount = reviewInput.length;
            const outputTextCount = (reviewOutput || "").length;
            ctx.ui.notify(
                `🧪 Review trace\nINPUT(${inputTextCount} chars): ${reviewInput.slice(0, 1000)}\nOUTPUT(${outputTextCount} chars): ${(reviewOutput || "").slice(0, 1000)}\n${formatUsageSummary(msg?.usage) ?? ch}`,
                "info",
            );

            if (msg?.stopReason === "error") {
                const em = msg?.errorMessage ? ` (${msg.errorMessage})` : '';
                ctx.ui.notify(`⚠ Review error — allowed: ${command.slice(0, 60)}${em}`, "warning");
                return undefined;
            }

            const text = getTextContent(msg.content);
            let decision = text ? parseReviewResult(text) : null;
            if (!decision) {
                const reason = "Review did not return valid structured verdict";
                writeReviewLog({
                    event: "fail_open_unparseable",
                    command,
                    model: getModelRef(reviewModel),
                    sessionId,
                    messageCount: messages.length,
                    systemPromptLength: systemPrompt?.length ?? 0,
                    droppedToolTraceMessages,
                    reviewInputLength: inputTextCount,
                    reviewOutputLength: outputTextCount,
                    reviewInput,
                    reviewOutput,
                    stopReason: msg?.stopReason,
                    usage: msg?.usage,
                    usageSummary: formatUsageSummary(msg?.usage),
                    rawContent: msg?.content,
                    reason,
                });
                if (shouldDebugReview()) {
                    ctx.ui.notify(`⚠ Raw review: ${(text || JSON.stringify(msg?.content ?? [])).slice(0, 220)}`, "warning");
                }
                ctx.ui.notify(`🧪 ${reason} (fail-open): ${command.slice(0, 80)} · ${formatUsageSummary(msg?.usage) ?? "CH N/A"}`, "warning");
                return undefined;
            }

            if (decision.allowed) {
                // Allowed: toast only, never inject into tool result (no context pollution)
                writeReviewLog({
                    event: "allow",
                    command,
                    model: getModelRef(reviewModel),
                    sessionId,
                    messageCount: messages.length,
                    systemPromptLength: systemPrompt?.length ?? 0,
                    droppedToolTraceMessages,
                    reviewInputLength: inputTextCount,
                    reviewOutputLength: outputTextCount,
                    reviewInput,
                    reviewOutput,
                    stopReason: msg?.stopReason,
                    usage: msg?.usage,
                    usageSummary: formatUsageSummary(msg?.usage),
                    verdict: "allow",
                    reason: decision.reason,
                });
                ctx.ui.notify(formatReviewToast(decision.reason, msg?.usage), "info");
                return undefined;
            }
            writeReviewLog({
                event: "block",
                command,
                model: getModelRef(reviewModel),
                sessionId,
                messageCount: messages.length,
                systemPromptLength: systemPrompt?.length ?? 0,
                droppedToolTraceMessages,
                reviewInputLength: inputTextCount,
                reviewOutputLength: outputTextCount,
                reviewInput,
                reviewOutput,
                stopReason: msg?.stopReason,
                usage: msg?.usage,
                usageSummary: formatUsageSummary(msg?.usage),
                verdict: "block",
                reason: decision.reason,
            });
            ctx.ui.notify(formatReviewToast(`Blocked: ${decision.reason}`, msg?.usage), "warning");
            return { block: true, reason: `${decision.reason}` };
        } catch {
            ctx.ui.notify(`⚠ Review error — allowed: ${command.slice(0, 80)}`, "warning");
            return undefined;
        }
    });
}
