# pi-auto-approve 🛡️

Auto-reviews bash commands before execution, similar to Codex's auto-reviewer.

## 三层防护

| 层级 | 行为 | 示例 |
|------|------|------|
| **1️⃣ 自动放行** | 直接运行，零延迟 | `ls`, `cd`, `grep`, `git status`, `echo` |
| **2️⃣ 自动阻止** | 直接拒绝 | `rm -rf`, `sudo`, `chmod 777`, `git push --force` |
| **3️⃣ 子模型审查 🎯** | 子模型独立决策 | `git commit`, `npm install`, `curl`, `mv`, `sed -i`, `cp` |

## 特性

- ✅ **进程内审查** — 使用 `createAgentSession()` 进程内调用，不 fork 子进程，审查更快
- ✅ **可配置审查模型** — 可指定专用模型做审查，不配置则跟随主模型
- ✅ **超时降级** — 子模型超时或出错时，回退到人工确认

## 安装

```bash
pi install git:github.com/wangzexi/pi-auto-approve
```

然后 `/reload` 即可生效。

## 配置审查模型

默认使用主模型（`defaultProvider`/`defaultModel`）。

如果想指定专用审查模型（比如用更强的模型做审查），在 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json` 中添加：

```json
{
  "autoApprove": {
    "model": "deepseek/deepseek-v4-pro"
  }
}
```

项目级配置（`.pi/settings.json`）优先级高于全局配置。

格式为 `provider/modelId`，支持 pi 中已配置的任何模型。
