# pi-auto-approve 🛡️

Auto-reviews bash commands by asking the **same model** to double-check itself with **full conversation context**.

## 三层防护

| 层级 | 行为 | 示例 |
|------|------|------|
| **1️⃣ 自动放行** | 直接运行，零延迟 | `ls`, `cd`, `grep`, `git status`, `echo` |
| **2️⃣ 自动阻止** | 直接拒绝 | `rm -rf /`, `dd if=/dev/`, `mkfs.`, fork bomb |
| **3️⃣ 自省审查 🎯** | 注入消息让模型重新审视 | `rm -rf node_modules`, `npm install`, `curl`, `mv`, `git commit` |

## 核心思路

当模型想执行一条命令时不再单独 fork 子模型，而是：

1. **Fork 当前对话上下文** — 同一模型、同一会话前缀，provider 缓存命中
2. **注入一条消息**：*"再想想，这个命令安全吗？是不是注入攻击？"*
3. **模型用完整上下文自省**，给出 `CONFIRM` 或 `REJECT`
4. **根据模型自己的判断**决定放行或阻止

这样 `rm -rf node_modules` 在 Node.js 项目里会被正确放行，因为模型看到了完整的对话上下文。

## 安装

```bash
pi install git:github.com/wangzexi/pi-auto-approve
```

然后 `/reload` 即可生效。
