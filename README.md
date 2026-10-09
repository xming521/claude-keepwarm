# claude-keepwarm（自用）

基于 [Delitefully/claude-keepwarm](https://github.com/Delitefully/claude-keepwarm) 修改，供自己在 Linux 上使用。

- 缓存到期前 5 分钟保活，每 60 秒检查一次，发送“等下我”。
- 每次发消息重置 8 次保活额度；支持当前对话暂停、恢复。
- 状态栏显示模型、effort、5h/7d 用量、上下文、Git 改动、缓存和保活倒计时，宽度不够时换行。
- 缓存倒计时与保活共用到期时间；恢复的缓存时间以 `~` 标记，直到新请求更新。

## 安装

需要 Claude Code、Bash、jq、Python 3 和 GNU 命令行工具。

在仓库目录执行：

```sh
claude plugin marketplace add xming521/claude-keepwarm
claude plugin install keepwarm@keepwarm
mkdir -p ~/.claude/keepwarm
cp scripts/statusline-command.sh ~/.claude/statusline-command.sh
cp plugins/keepwarm/scripts/write-cache.sh ~/.claude/keepwarm/write-cache.sh
```

将以下字段合并到 `~/.claude/settings.json`：

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "KEEPWARM_PING_TEXT": "等下我",
    "KEEPWARM_CACHE_MARGIN_MIN": "5"
  },
  "statusLine": {
    "type": "command",
    "command": "bash \"$HOME/.claude/statusline-command.sh\"",
    "refreshInterval": 1
  }
}
```

重开 Claude Code，继续原对话即可。

## 开关

```text
/keepwarm status   查看当前对话状态
/keepwarm pause    暂停当前对话保活
/keepwarm resume   恢复当前对话保活
```

退出 Claude Code 后停止保活。缓存已过期时等待下一次正常对话。
