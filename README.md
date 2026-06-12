# pi-auto-approve 🛡️

自动审查危险命令的 Pi 扩展。Forked from [pi-auto-reviewer](https://github.com/vinzenzu/pi-auto-reviewer)。

## 三层防护

| 层级 | 行为 | 示例 |
|------|------|------|
| **1️⃣ 自动放行** | 直接运行，零延迟 | `ls`, `cd`, `grep`, `git status`, `echo` |
| **2️⃣ 自动阻止** | 直接拒绝 | `rm -rf`, `sudo`, `chmod 777`, `git push --force` |
| **3️⃣ 子模型审查 🎯** | 子模型独立决策 | `git commit`, `npm install`, `curl`, `mv`, `sed -i`, `cp` |

## 与原版的区别

- ✅ **进程内审查** — 使用 `createAgentSession()` 替代 `spawn()` 子进程，审查更快
- ✅ **锁定模型** — 子模型固定 `deepseek/deepseek-v4-flash`，速度与成本可控

## 安装

```bash
pi install git:github.com/wangzexi/pi-auto-approve
```

然后 `/reload` 即可生效。
