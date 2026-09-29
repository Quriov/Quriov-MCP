# Quriov 命令行 `quriov`

Quriov（https://quriovai.com）出图出视频的官方命令行。一条 `quriov setup` 把三样东西一起装好，全部用同一把钥匙：

- **MCP**：给本机的 Claude Code / Codex / Cursor 写好名为 `quriov` 的 MCP，聊天里就能出图出视频；
- **技能**：教 AI 什么时候用 MCP、什么时候用命令行、花钱前先估价；
- **命令行**：批量出图（一张表，每行一个商品）、本地参考图自动上传、结果下载到文件夹、每张花多少点写进 `cost.csv`、断了接着跑不重复扣钱。

## 安装

**见 https://quriovai.com/install.md**（唯一的安装说明）。最省事的做法：在网页 https://quriovai.com/me/access-keys 建一把钥匙，点「复制给 AI 安装」，粘给你的 AI。

## 常用命令

```text
quriov setup              # 装好 / 修好：验钥匙、写 MCP、装技能、自检（--dry-run 只看不写）
quriov doctor             # 只读自检：钥匙、MCP、客户端配置、技能、是不是最新版
quriov update             # 有新版就下载并装上；已是最新就说一声
quriov uninstall          # 删掉 quriov 写过的配置、技能和本机保存的钥匙
quriov account            # 余额
quriov models             # 能用的模型、模板编号、每张多少点
quriov upload a.jpg       # 上传本地参考图，打印给 MCP 用的链接

quriov gen -m <模型> -p "白底主图" --ref a.jpg -n 4 -o ./out        # 单张 / 小批
quriov batch plan products.csv -m <模型> --estimate                 # 只估价，不花钱
quriov batch run  products.csv -m <模型> -o ./out                   # 确认后提交、等结果、下载
quriov batch resume ./out                                            # 断了接着跑

quriov batch submit items.jsonl --dry-run                           # 整批交给服务端：先估价
quriov batch submit items.jsonl --yes                               # 确认后提交（每次最多 50 条自动分组）
quriov batch status <批次号> --wait --download ./out                  # 等全部结束，按 标记/模板 下载
quriov jobs get <任务号>                                              # 按任务号查
quriov jobs list --tag SKU123 --status failed --all                  # 翻历史（自动翻页）
quriov jobs query <任务号...>                                          # 一次查多个
quriov jobs cancel <任务号>                                           # 取消还在排队的（不扣费）
```

以上命令加 `--json` 输出机器可读的结果（给 AI / 脚本用）；出错时 JSON 里有 `error_code`、中文 `reason`、`request_id`。

`quriov --help` 有完整用法和退出码。

## 更新

```text
quriov update
```

查 GitHub 上本仓的最新发布版，比当前新就下载 `quriov.tgz` 到临时目录，再用 `npm install -g` 装回**当前这份 quriov 所在的位置**（装在自定义 `--prefix` 的也装回原处）；本机已装的技能一起同步成新版。已是最新就只说一句。装完运行 `quriov doctor` 检查一遍。

- 平时运行任何命令时，距上次检查超过 24 小时就顺手在后台查一次（最多等 2 秒，查不到不出声），有新版就在**标准错误输出**提示一行；标准输出不受影响，`--json` 的结果照样能被程序解析。结果缓存在配置目录（和保存的钥匙同一个目录）的 `update-check.json`。
- 不想让它查：设环境变量 `QURIOV_NO_UPDATE_CHECK=1`（CI 环境里本来就不查）。
- 国内网络连不上 GitHub 时，`update` 会给出发布页的下载地址：用浏览器下载后运行 `npm install -g <下载的文件>`（Windows 用 `npm.cmd`）。
- 权限不够（EACCES）时按提示改装到自己的目录，和安装说明里的做法一致。

## 批量表格

第一行是表头，每行一个商品（Excel 另存为「CSV UTF-8」即可）；例子见 [`examples/products.csv`](examples/products.csv)。

| 列 | 意思 |
| --- | --- |
| `sku` 货号 | 必填，也是输出子文件夹的名字 |
| `refs` 参考图 | 分号隔开，路径相对这张表所在的文件夹 |
| `templates` 模板 | 分号隔开；**每个模板 = 一个图位 = 一次提交**，编号用 `quriov models` 查 |
| `prompt` 提示词 | 必填，商品描述（模板会接在它前面） |
| `model` 模型 | 可不填，改用命令里的 `-m` |
| `aspect_ratio` 比例 | 如 `1:1`、`3:4`；不填用模板自己的比例 |
| `n` 张数 | 每个图位几张（1–4，默认 1） |

也可以用文件夹：每个子文件夹是一个商品，里面的图当参考图，可放 `prompt.txt`；图位用 `--templates a,b,c` 指定。

结果在 `out/<货号>/<图位>.png`；`out/cost.csv` 每行的点数直接来自服务端返回（带 BOM，Excel 打开不乱码）。

## 整批交给服务端（`batch submit`）

和上面「一张表 + 本地参考图」的 `batch run` 不同，`batch submit` 把整批条目交给服务端，由服务端逐条提交；进度、结果、实扣都在服务端查。适合 AI 或脚本整理好条目后一次交。

条目文件是 JSONL（一行一条）或 JSON 数组（也可以是 `{"batch_key": "...", "items": [...]}`），`-` 表示从标准输入读：

```jsonl
{"model": "<模型>", "prompt": "白底主图，正面平铺", "template_ids": ["main_image", "detail_1"], "reference_urls": ["https://…"], "aspect_ratio": "1:1", "n": 1, "tag": "SKU123"}
{"model": "<模型>", "prompt": "蓝色水杯，木桌场景", "n": 2, "tag": "SKU124"}
```

| 字段 | 意思 |
| --- | --- |
| `model` / `prompt` | 必填 |
| `template_ids` | 每个模板各出 `n` 张，最多 8 个；编号用 `quriov models` 查 |
| `reference_urls` | 参考图 https 链接；本地图先 `quriov upload` |
| `aspect_ratio` / `n` | 画幅 / 每个模板几张（1–4） |
| `tag` | 你自己的标记（如货号）；下载时当文件夹名，`jobs list --tag` 可按它筛 |
| `idempotency_key` | 一般不填：命令行按条目内容自动算，同一个文件重跑不会重复扣钱 |

- 先估价、再确认（非交互要加 `--yes`）；余额不够整批时一条都不交。
- 每次请求最多 50 条（`--chunk-size` 可调小），多的自动分组，全部归在同一个批次下（也可用 `--batch-key` 自己指定）。
- 中途断了、超时了、充值后：原样重跑同一条命令，已交的原样返回、不扣钱，没交上的补交。
- `batch status <批次号> --download ./out` 把结果存成 `out/<tag>/<模板>.png`（同一模板多张时加 `-1`、`-2`）；结果云端只留 1 天。
- 只有服务端临时不可用（HTTP 503）会按它给的等待时间自动重试几次；其余错误不重试，报出中文原因、错误码和请求编号。

## 钥匙与安全

- 钥匙只从隐藏输入、标准输入（`--key-stdin`）或环境变量 `QURIOV_API_KEY` 读，**永远不从命令参数读**；不打印、不写进日志和批次存档。
- 用哪把钥匙：环境变量 `QURIOV_API_KEY` > `quriov setup` 保存的 > 旧环境变量名；`account` / `doctor` / 报错都会说正在用哪一把。第一把没通过验证时自动换下一把，并提醒你删掉失效的环境变量。
- `setup` 把钥匙存进本机用户目录（仅本人可读写），并写进三个客户端的用户级 MCP 配置（图形版客户端读不到 shell 里的环境变量）。卸载不会作废钥匙，作废请到网页撤销。
- 零依赖，只用 Node 20+ 自带的功能；只连 `https://quriovai.com` 和它返回的结果图链接，外加查新版 / 升级时连 GitHub 上本仓的发布页（`api.github.com` 与 `github.com`，不带钥匙）。

漏洞报告见 [SECURITY.md](SECURITY.md)。许可：[MIT](LICENSE)。
