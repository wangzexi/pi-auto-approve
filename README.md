# pi-auto-approve

让 Pi 在每次执行 bash 命令前**用完整对话上下文自省**，确认安全才放行。

## 三层防护

| 层级 | 行为 | 示例 |
|------|------|--------|
| **1️⃣ 自动放行** | 正则匹配，零延迟 | `ls`, `pwd`, `echo`, `git status` |
| **2️⃣ 自动阻止** | 正则匹配，直接拒绝 | `rm -rf /`, `dd if=/dev/`, `mkfs.` |
| **3️⃣ 自省审查** | 同模型自省，缓存友好 | `rm -rf node_modules`, `npm install`, `curl` |

## 核心设计

不同于其他工具的"独立子模型审查"，pi-auto-approve 的做法是：

1. **同模型自省** — 用当前对话的同一模型、同一会话前缀重新审查即将执行的命令
2. **缓存友好** — 审查请求复用主会话前缀（系统提示词、历史消息、sessionId），通常更有利于前缀缓存命中
3. **模型自省** — 模型基于完整对话考虑风险等级、用户意图、注入风险、替代方案
4. **结果不注入** — 通过的命令不注入任何审批记录，模型看不到审查存在；被阻止的命令直接返回原因

## 安装

```bash
pi install git:github.com/wangzexi/pi-auto-approve
```

然后 `/reload` 即可生效。

## 命令

### `/autoapprove`

开关自动审查：

- `/autoapprove` — 切换开/关；关闭后所有 bash 命令直接执行，不做任何检查

适合在已知安全的批量操作前临时关闭。

## 配置

零配置，开箱即用。审查使用当前对话的同一模型。

## 测试

```bash
PI_TEST_MODEL=deepseek/deepseek-v4-pro bun run test
```
