/**
 * pi-auto-approve
 *
 * Auto-reviews bash commands before execution, similar to Codex's auto-reviewer.
 *
 * Three tiers:
 *   1. Auto-permitted: safe commands (ls, cd, grep, git status, etc.)
 *   2. Auto-blocked: obviously dangerous (rm -rf, sudo, chmod 777)
 *   3. Needs review: everything else → call a subagent LLM to decide
 *
 * The reviewer calls the model directly via completeSimple() — no subprocess,
 * no AgentSession overhead.
 *
 * Configuration (optional):
 *   Add to ~/.pi/agent/settings.json or .pi/settings.json:
 *     "autoApprove": { "model": "deepseek/deepseek-v4-pro" }
 *   If unset, falls back to defaultProvider/defaultModel.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AuthStorage, getAgentDir, ModelRegistry } from "@earendil-works/pi-coding-agent";

// ── Tier 1: Auto-permitted command patterns ──
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

// ── Tier 2: Auto-blocked patterns ──
const AUTO_BLOCKED = [
    /\brm\s+(-rf?|--recursive)\b/,
    /\brm\s+(-rf?|--recursive)\s+\/\b/,
    /\bsudo\b/,
    /\bchmod\s+.*777/,
    /:\(\)\s*\{/,
    /\bdd\s+if=/,
    /\bmkfs\./,
    /\b(shutdown|reboot|halt|poweroff)\b/,
    /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-[fd]+)\b/,
    />\s*\/dev\//,
];

// ── Review prompt ──
function buildReviewPrompt(command: string, cwd: string): string {
    const projectName = path.basename(cwd);
    return `You are a security reviewer for a coding agent. You must decide whether to ALLOW or BLOCK the following bash command.

=== COMMAND ===
${command}

=== CURRENT DIRECTORY ===
${cwd}

=== PROJECT ===
${projectName}

=== REVIEW RULES ===
1. Commands that ONLY read files, list directories, show info, or display state → ALLOW
2. Commands that modify files or system state → ALLOW if constructive (install deps, build, lint, format, test)
3. Commands that delete files, force-push, reset, or alter system config → BLOCK unless clearly intentional and scoped
4. Commands with environment variables like $SECRET or $TOKEN → BLOCK to prevent leaks
5. Commands that install from unverified sources (curl pipe bash, wget pipe sh) → BLOCK
6. Package manager installs (npm install, pip install, cargo add) → ALLOW (standard dev workflow)
7. Network operations like curl/wget to download files → ALLOW if to a project directory, BLOCK if suspicious
8. Any command that would affect files outside the project directory → BLOCK unless clearly a dev tool

=== RESPONSE FORMAT ===
Reply with ONLY one line:
- "ALLOW: <brief reason>" — to permit the command
- "BLOCK: <brief reason>" — to prevent the command

Do not include any other text, markdown, or explanation.`;
}

// ── Parse ALLOW/BLOCK ──
function parseDecision(text: string): { allowed: boolean; reason: string } | null {
    const allowMatch = text.match(/^ALLOW:\s*(.+)/im);
    if (allowMatch) return { allowed: true, reason: allowMatch[1].trim() };
    const blockMatch = text.match(/^BLOCK:\s*(.+)/im);
    if (blockMatch) return { allowed: false, reason: blockMatch[1].trim() };
    return null;
}

// ── Read autoApprove.model from settings ──
function findReviewModel(cwd: string, agentDir: string): { provider: string; modelId: string } | undefined {
    for (const sp of [path.join(cwd, ".pi", "settings.json"), path.join(agentDir, "settings.json")]) {
        try {
            const raw = JSON.parse(fs.readFileSync(sp, "utf-8"));
            const cfg = raw.autoApprove;
            if (cfg?.model && typeof cfg.model === "string") {
                const parts = cfg.model.split("/");
                if (parts.length === 2) return { provider: parts[0], modelId: parts[1] };
            }
        } catch { /* ignore */ }
    }
    return undefined;
}

// ── Review: direct model call, no session ──
async function reviewWithLLM(
    command: string,
    cwd: string,
    signal: AbortSignal | undefined,
): Promise<{ allowed: boolean; reason: string }> {
    const prompt = buildReviewPrompt(command, cwd);
    const agentDir = getAgentDir();

    // Resolve model
    const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
    const configured = findReviewModel(cwd, agentDir);
    const provider = configured?.provider ?? "deepseek";
    const modelId = configured?.modelId ?? "deepseek-v4-flash";
    const model = modelRegistry.find(provider, modelId);
    if (!model) {
        return { allowed: false, reason: `Review model ${provider}/${modelId} not found` };
    }

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
        return { allowed: false, reason: `Auth failed: ${auth.error}` };
    }

    // Timeout via AbortSignal
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    if (signal) {
        if (signal.aborted) { clearTimeout(timer); return { allowed: false, reason: "Review aborted" }; }
        signal.addEventListener("abort", () => { clearTimeout(timer); abort.abort(); }, { once: true });
    }

    try {
        const message = await completeSimple(model, [
            { role: "user", content: [{ type: "text" as const, text: prompt }] },
        ], {
            apiKey: auth.apiKey,
            signal: abort.signal,
        });

        const text = message.content
            .filter((p): p is TextContent => p.type === "text")
            .map((p) => p.text)
            .join("");

        const decision = text ? parseDecision(text) : null;
        if (decision) return decision;
        return { allowed: false, reason: `Reviewer response unclear: "${text.slice(0, 200)}"` };
    } finally {
        clearTimeout(timer);
    }
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return undefined;

        const command = (event.input.command as string).trim();
        if (!command) return undefined;

        for (const pattern of AUTO_BLOCKED) {
            if (pattern.test(command)) {
                return { block: true, reason: `Auto-blocked: matches dangerous pattern "${pattern.source}"` };
            }
        }

        for (const pattern of AUTO_PERMITTED) {
            if (pattern.test(command)) {
                return undefined;
            }
        }

        if (!ctx.hasUI) {
            return { block: true, reason: "Command requires review but no UI available" };
        }

        ctx.ui.setStatus("auto-approve", `Reviewing: ${command.slice(0, 60)}...`);

        try {
            const decision = await reviewWithLLM(command, ctx.cwd, ctx.signal);
            ctx.ui.setStatus("auto-approve", undefined);

            if (decision.allowed) {
                ctx.ui.notify(`Auto-approve: ✓ ${decision.reason}`, "info");
                return undefined;
            } else {
                ctx.ui.notify(`Auto-approve: ✗ ${decision.reason}`, "warning");
                return { block: true, reason: `Auto-approve blocked: ${decision.reason}` };
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
