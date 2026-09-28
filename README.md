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
quriov doctor             # 只读自检：钥匙、MCP、客户端配置、技能
quriov uninstall          # 删掉 quriov 写过的配置、技能和本机保存的钥匙
quriov account            # 余额
quriov models             # 能用的模型、模板编号、每张多少点
quriov upload a.jpg       # 上传本地参考图，打印给 MCP 用的链接

quriov gen -m <模型> -p "白底主图" --ref a.jpg -n 4 -o ./out        # 单张 / 小批
quriov batch plan products.csv -m <模型> --estimate                 # 只估价，不花钱
quriov batch run  products.csv -m <模型> -o ./out                   # 确认后提交、等结果、下载
quriov batch resume ./out                                            # 断了接着跑
```

`quriov --help` 有完整用法和退出码。

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

## 钥匙与安全

- 钥匙只从隐藏输入、标准输入（`--key-stdin`）或环境变量 `QURIOV_API_KEY` 读，**永远不从命令参数读**；不打印、不写进日志和批次存档。
- 用哪把钥匙：环境变量 `QURIOV_API_KEY` > `quriov setup` 保存的 > 旧环境变量名；`account` / `doctor` / 报错都会说正在用哪一把。第一把没通过验证时自动换下一把，并提醒你删掉失效的环境变量。
- `setup` 把钥匙存进本机用户目录（仅本人可读写），并写进三个客户端的用户级 MCP 配置（图形版客户端读不到 shell 里的环境变量）。卸载不会作废钥匙，作废请到网页撤销。
- 零依赖，只用 Node 20+ 自带的功能；只连 `https://quriovai.com` 和它返回的结果图链接。

漏洞报告见 [SECURITY.md](SECURITY.md)。许可：[MIT](LICENSE)。
