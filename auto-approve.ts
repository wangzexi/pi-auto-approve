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
 * The reviewer subagent runs in-process via createAgentSession() (no subprocess)
 * and is locked to deepseek/deepseek-v4-flash.
 */

import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createAgentSession,
    SessionManager,
    SettingsManager,
    getAgentDir,
    ModelRegistry,
    AuthStorage,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

// ── Tier 1: Auto-permitted command patterns ──
//
// These are regexps tested against the full command string.
// The model will never see these — they bypass review entirely.
const AUTO_PERMITTED = [
    // Read-only directory listing
    /^(ls|dir|tree)\b/,
    // Directory navigation
    /^cd\b/,
    // Read-only file ops
    /^(cat|head|tail|less|more)\b/,
    /^(file|stat|wc|du|df)\b/,
    // grep / rg / ag — read-only search
    /^(grep|rg|ag|ack)\b/,
    // find / locate — read-only
    /^(find|locate|which|whereis|type)\b/,
    // Git read-only operations
    /^git\s+(status|log|diff|show|branch|tag|stash\s+list|remote|ls-remote|rev-parse|rev-list|describe|whatchanged|shortlog|blame|grep|config\s+--get|config\s+--list|config\s+-l)\b/,
    /^git\s+log\b/,
    // Docker/container read-only
    /^(docker|podman)\s+(ps|images|inspect|logs|stats|info|version|history|top|diff)\b/,
    // Package manager info/list
    /^(npm|yarn|pnpm)\s+(list|info|view|outdated|audit|why|config\s+list)\b/,
    /^(pip|pip3)\s+(list|show|freeze|search)\b/,
    /^(cargo|go)\s+(search|doc)\b/,
    // System info
    /^(echo|printenv|env|whoami|hostname|uname|uptime|id|groups|pwd|date)\b/,
    // Python/node one-off checks (no args = safe)
    /^(python3?|node|uv|tsx|npx)\s+(--version|-v|--help|-h)$/,
    // Help flags
    /^.*\s+(--help|-h)\s*$/,
    // Simple echo (for env var checks, etc.)
    /^echo\s/,
    // Print working directory
    /^pwd\b/,
];

// ── Tier 2: Auto-blocked patterns (never run, never ask) ──
const AUTO_BLOCKED = [
    // Destructive file ops
    /\brm\s+(-rf?|--recursive)\b/,
    /\brm\s+(-rf?|--recursive)\s+\/\b/,
    // Privilege escalation
    /\bsudo\b/,
    // Permission changes that are too open
    /\bchmod\s+.*777/,
    // Fork bombs and resource exhaustion
    /:\(\)\s*\{/,  // fork bomb pattern
    // Disk destructive
    /\bdd\s+if=/,
    /\bmkfs\./,
    // System shutdown
    /\b(shutdown|reboot|halt|poweroff)\b/,
    // Git destructive without review
    /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-[fd]+)\b/,
    // Direct /dev writes
    />\s*\/dev\//,
];

// ── Review prompt template ──
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

// ── Extract last assistant text from session messages ──
function lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i] as Partial<AssistantMessage> | undefined;
        if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
        const text = message.content
            .filter((part): part is TextContent => part.type === "text")
            .map((part) => part.text)
            .join("");
        if (text.trim()) return text;
    }
    return "";
}

// ── Parse ALLOW/BLOCK from reviewer response ──
function parseDecision(text: string): { allowed: boolean; reason: string } | null {
    const allowMatch = text.match(/^ALLOW:\s*(.+)/im);
    if (allowMatch) return { allowed: true, reason: allowMatch[1].trim() };

    const blockMatch = text.match(/^BLOCK:\s*(.+)/im);
    if (blockMatch) return { allowed: false, reason: blockMatch[1].trim() };

    return null;
}

// ── Review via in-process AgentSession (no subprocess) ──
async function reviewWithLLM(
    command: string,
    cwd: string,
    signal: AbortSignal | undefined,
): Promise<{ allowed: boolean; reason: string }> {
    const prompt = buildReviewPrompt(command, cwd);
    const agentDir = getAgentDir();

    // Lock to deepseek-v4-flash
    const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
    const model = modelRegistry.find("deepseek", "deepseek-v4-flash");

    const { session } = await createAgentSession({
        cwd,
        agentDir,
        authStorage,
        modelRegistry,
        model,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.create(cwd, agentDir),
        customTools: [],
        noTools: "all",
        tools: [],
        thinkingLevel: "off",
    });

    // Timeout + abort handling
    const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
            session.abort();
            reject(new Error("Review timed out after 15s"));
        }, 15000);

        if (signal) {
            if (signal.aborted) {
                clearTimeout(timer);
                reject(new Error("Review aborted"));
                return;
            }
            const onAbort = () => {
                clearTimeout(timer);
                session.abort();
                reject(new Error("Review aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });

    try {
        await Promise.race([
            session.prompt(prompt),
            timeout,
        ]);

        // Parse result from session messages
        const text = lastAssistantText(session.messages as unknown[]);
        const decision = text ? parseDecision(text) : null;

        if (decision) return decision;

        return { allowed: false, reason: `Reviewer response unclear: "${text.slice(0, 200)}"` };
    } finally {
        session.dispose();
    }
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return undefined;

        const command = (event.input.command as string).trim();
        if (!command) return undefined;

        // Tier 2: Auto-blocked
        for (const pattern of AUTO_BLOCKED) {
            if (pattern.test(command)) {
                return { block: true, reason: `Auto-blocked: matches dangerous pattern "${pattern.source}"` };
            }
        }

        // Tier 1: Auto-permitted
        for (const pattern of AUTO_PERMITTED) {
            if (pattern.test(command)) {
                return undefined; // allow through
            }
        }

        // Tier 3: Needs review
        if (!ctx.hasUI) {
            // Non-interactive mode: block by default
            return { block: true, reason: "Command requires review but no UI available" };
        }

        ctx.ui.setStatus("auto-reviewer", `Reviewing: ${command.slice(0, 60)}...`);

        try {
            const decision = await reviewWithLLM(command, ctx.cwd, ctx.signal);

            ctx.ui.setStatus("auto-reviewer", undefined);

            if (decision.allowed) {
                ctx.ui.notify(`Auto-reviewer: ✓ ${decision.reason}`, "info");
                return undefined; // allow through
            } else {
                ctx.ui.notify(`Auto-reviewer: ✗ ${decision.reason}`, "warning");
                return { block: true, reason: `Auto-reviewer blocked: ${decision.reason}` };
            }
        } catch (err) {
            ctx.ui.setStatus("auto-reviewer", undefined);
            const msg = err instanceof Error ? err.message : String(err);

            // On review failure, ask user
            const choice = await ctx.ui.select(
                `⚠️  Auto-review failed: ${msg}\n\nCommand: ${command}\n\nAllow?`,
                ["Yes", "No"],
            );
            if (choice !== "Yes") {
                return { block: true, reason: "Auto-review failed and user declined" };
            }
            return undefined;
        }
    });

    // Clean up status on session end
    pi.on("session_shutdown", async (_event, _ctx) => {
        // No cleanup needed; status is session-scoped
    });
}
