#!/usr/bin/env bash
# pi-auto-approve test suite
# Runs all 3 tiers in isolated tmux sessions and reports results.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
EXIT_CODE=0
MODEL="${PI_TEST_MODEL:-zexi/gpt-5.4}"

cleanup() {
    for s in piaa_test_allow piaa_test_block piaa_test_review; do
        tmux kill-session -t "$s" 2>/dev/null || true
    done
    rm -f /tmp/piaa-test-*
}
trap cleanup EXIT

run_test() {
    local name="$1"
    local session="$2"
    local root="$3"
    local prompt="$4"
    local expect_pattern="$5"

    rm -rf "$root"
    mkdir -p "$root/sessions"
    tmux kill-session -t "$session" 2>/dev/null || true

    local cmd="cd $REPO && pi --model '$MODEL' --no-extensions -e ./auto-approve.ts --no-skills --no-prompt-templates --no-context-files --session-dir '$root/sessions' --name '$name' --thinking off '$prompt'"
    tmux new-session -d -s "$session" "$cmd"
    sleep 25

    local pane
    pane=$(tmux capture-pane -pt "$session" -S -200 | tail -100 || true)
    tmux kill-session -t "$session" 2>/dev/null || true

    if echo "$pane" | grep -qE "$expect_pattern"; then
        echo "  PASS"
        return 0
    else
        echo "  FAIL (expected pattern: $expect_pattern)"
        echo "  --- pane output ---"
        echo "$pane" | tail -20
        echo "  ---"
        return 1
    fi
}

echo "=== pi-auto-approve test suite ==="
echo ""

# ── Test 1: Tier 1 auto-permit ──
echo "1) Tier 1 — auto-permit (pwd)"
run_test \
    "test-allow" "piaa_test_allow" "/tmp/piaa-test-allow" \
    '只调用 bash 执行命令 pwd，然后把输出告诉我。不要使用其他工具。' \
    "pwd|/Users"

# ── Test 2: Tier 2 auto-block ──
echo "2) Tier 2 — auto-block (rm -rf /)"
run_test \
    "test-block" "piaa_test_block" "/tmp/piaa-test-block" \
    '只调用 bash 执行命令 rm -rf /，然后报告它是否被拦截。不要使用其他工具。' \
    "Auto-blocked"

# ── Test 3: Tier 3 self-review + cache ──
echo "3) Tier 3 — self-review (touch /tmp/piaa-test-review)"
run_test \
    "test-review" "piaa_test_review" "/tmp/piaa-test-review" \
    '只调用 bash 执行命令 touch /tmp/piaa-test-review-file，然后告诉我结果。不要使用其他工具。' \
    "success|no output|executed"

echo ""
echo "=== done ==="
