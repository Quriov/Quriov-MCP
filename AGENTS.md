# 给在本仓改代码的 AI

本仓是 Quriov 官方命令行 `quriov`（零依赖 Node 20+）和它随包带的技能 `skill/SKILL.md`。怎么装只写在 https://quriovai.com/install.md，别在本仓另写一份安装步骤。

必须守住的：

- 仓里不许有真钥匙或任何凭据（测试用明显是假的值）。
- 钥匙不进命令参数、链接、日志、输出、批次存档（`.quriov/*.json`、`cost.csv`）；下载结果图时不带钥匙。
- 只连 `https://quriovai.com`（所有地址从 `lib/common.mjs` 的 `ORIGIN` 拼）和服务端返回的 https 结果链接。
- 和服务端说话只走 `lib/transport.mjs`；以后换成直连接口时只改这个文件。
- `quriov setup` / `uninstall` 只动 Claude Code、Codex、Cursor 三个客户端的用户级配置里名为 `quriov` 的那一项和 `<技能目录>/quriov/`；解析不了的文件不碰；测试一律用假的用户目录（`main(..., { home })`），绝不碰真的 `~`。
- 花钱前先拿服务端估价并确认（非交互要 `--yes`）；点数只用服务端返回的数，不内置价目表。
- 自检只查核心工具在不在，不比工具总数；文档和技能里不写死工具总数、服务端限额数字、版本号（版本号只在 `package.json`）。
- 改完跑 `npm test`；新行为要有测试。
