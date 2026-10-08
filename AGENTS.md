# 给在本仓改代码的 AI

本仓是 Quriov 官方命令行 `quriov`（零依赖 Node 20+）和它随包带的技能 `skill/SKILL.md`。怎么装只写在 https://quriovai.com/install.md，别在本仓另写一份安装步骤。

必须守住的：

- 仓里不许有真钥匙或任何凭据（测试用明显是假的值）。
- 钥匙不进命令参数、链接、日志、输出、批次存档（`.quriov/*.json`、`cost.csv`）；下载结果图时不带钥匙。
- 只连 `https://quriovai.com`（所有地址从 `lib/common.mjs` 的 `ORIGIN` 拼）和服务端返回的 https 结果链接；唯一例外是 `lib/update.mjs` 查新版 / 下载新版时连 GitHub 上本仓的发布页，不带钥匙，下载链接只认本仓发布页的。
- 「有新版」自动提示只写 stderr，stdout 一个字都不能动（批量出图的输出要能被程序解析）；查不到、超时一律静默；`QURIOV_NO_UPDATE_CHECK=1` 关掉。测试里绝不真连 GitHub、绝不真跑 npm。
- 和服务端说话只走 `lib/transport.mjs`（MCP 和直连接口 `/api/v1/mcp/*` 都在这里）；批量提交 / 任务查询的命令在 `lib/batch.mjs`。报错一律带中文原因、错误码、请求编号；只自动重试 503。
- 详情套图的命令在 `lib/aplus.mjs`（接口 `/api/v1/aplus/*`，报错原因在 `detail` 里）。它的提交没有去重键：**提交那一下绝不自动重试**（断网、超时、5xx、503 都不重发），一律按「结果不确定」报出来并指去 `quriov aplus jobs`；也不能在报错里说「重跑不会重复扣钱」。
- `quriov setup` / `uninstall` 只动 Claude Code、Codex、Cursor 三个客户端的用户级配置里名为 `quriov` 的那一项和 `<技能目录>/quriov/`；解析不了的文件不碰；测试一律用假的用户目录（`main(..., { home })`），绝不碰真的 `~`。
- 花钱前先拿服务端估价并确认（非交互要 `--yes`）；点数只用服务端返回的数，不内置价目表。
- 自检只查核心工具在不在，不比工具总数；文档和技能里不写死工具总数、服务端限额数字、版本号（版本号只在 `package.json`）。
- 改完跑 `npm test`；新行为要有测试。
