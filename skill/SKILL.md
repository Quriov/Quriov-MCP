---
name: quriov
description: 用 Quriov 出图出视频：聊天里出一两张走 Quriov MCP 工具；批量（多个货号 × 多个图位）、本地参考图、要把图存进文件夹、按任务号查结果 / 翻历史 / 取消走命令行 quriov。用户要生成商品图、电商套图、带参考图出图、批量出图、查出图结果或生成视频时使用。
---

# Quriov 出图 / 出视频

MCP 工具（名为 `quriov` 的 MCP 服务）和命令行 `quriov` 用**同一把钥匙**、打**同一个后端**，扣费、作品库都一样。区别只在谁来干活：

| 场景 | 用什么 |
|---|---|
| 批量，条目由你（AI）整理好：参考图已是 https 链接或没有参考图，每条可带多个模板 | 命令行 `quriov batch submit`（整批交给服务端）+ `quriov batch status --wait --download` |
| 批量，手上是一张表 + 本地参考图，要一张费用清单 | 命令行 `quriov batch plan / run`（本机按表跑，自动上传参考图） |
| 本地参考图（尤其是真实照片） | 命令行 `quriov gen --ref` / `quriov batch run`（自动上传）；或先 `quriov upload` 换成链接 |
| 按任务号查结果、翻历史、取消排队中的任务 | 命令行 `quriov jobs get / list / query / cancel` |
| 聊天里出一两张、边看边改；出视频 | MCP 工具 |

给 AI 用时一律加 `--json`（输出和报错都是 JSON，报错带 `error_code`、中文 `reason`、`request_id`）。

⛔ 不要为批量出图自己写循环脚本去调 MCP 或别的接口 —— 控速、断点续跑、不重复扣钱、下载和费用清单命令行都做了。

## 红线

- 钥匙已经由 `quriov setup` 配好。不读取、不打印钥匙，不把钥匙写进命令参数、链接、日志、文件或提交。
- **花钱前先估价，并得到用户明确确认**。命令行的 `--yes` 只能在用户看过并确认那次估价之后加。
- 不伪造链接、状态或结果；没确认成功就如实说还在跑或失败了。
- 费用只报接口返回的点数，不按价目表自己算。
- 不要把图片转成 base64 塞进工具调用（一张 2 MB 的照片约 67 万 token，会被截断成坏数据）；本地图一律先上传换链接。

## 批量出图（命令行）

先确认命令行在：`quriov --version`。跑不起来 = 没装好，请用户按 https://quriovai.com/install.md 重装，不要改成自写脚本。

```bash
quriov account      # 余额
quriov models       # 能用的模型、模板编号、每张多少点
```

CSV 一行一个货号，列为 `sku,refs,templates,prompt,model,aspect_ratio,n`（中文表头 `货号,参考图,模板,提示词,模型,比例,张数` 也认）：

- `refs`：参考图路径，多张用 `;` 隔开，相对 CSV 所在文件夹。
- `templates`：模板编号（`quriov models` 里看），多个用 `;` 隔开；**一个模板 = 一个图位 = 一次提交**。
- `n`：每个图位几张（1–4），按实际出图张数扣费。

固定流程：

1. `quriov batch plan products.csv -m <模型> --estimate`：列计划并联网估价（免费；不加 `--estimate` 完全不联网）。表格有问题会一次全列出来，一张都不提交。
2. 把估价原样告诉用户：多少次提交、多少张、预计多少点、当前余额。
3. 用户明确确认后：`quriov batch run products.csv -m <模型> -o ./out --yes`。它自动上传参考图、提交、等结果、下载、写费用清单。
4. 汇报：输出文件夹（`out/<货号>/<图位>.png`）、`out/cost.csv` 的点数合计（读文件求和）、失败的货号 / 图位。

断了：`quriov batch status ./out` 看进度，`quriov batch resume ./out` 接着跑；已提交的不会重复扣钱。失败的要重试加 `--retry-failed`（会再花钱，先估价再确认）。

单个商品快速出几张：

```bash
quriov gen -m <模型> -p "白底主图，正面平铺" --ref a.jpg --ref b.jpg -n 4 -o ./out
```

## 整批交给服务端（batch submit）

条目写成 JSONL（一行一条）或 JSON 数组。每条 = 一个商品的一组图：`template_ids` 里每个模板各出 `n` 张；不给模板就按提示词出 `n` 张。

```jsonl
{"model": "<模型>", "prompt": "白底主图，正面平铺，保留 logo", "template_ids": ["main_image", "detail_1"], "reference_urls": ["https://…"], "aspect_ratio": "1:1", "n": 1, "tag": "SKU123"}
{"model": "<模型>", "prompt": "蓝色水杯，木桌场景", "n": 2, "tag": "SKU124"}
```

字段：`model`、`prompt` 必填；`template_ids`（最多 8 个）、`reference_urls`（https 链接，本地图先 `quriov upload`）、`aspect_ratio`、`n`（1–4）、`tag`（你自己的标记，如货号；下载时当文件夹名）、`idempotency_key`（一般不用填）。

固定流程：

1. `quriov batch submit items.jsonl --dry-run --json`：每条估价、要新交几条、合计点数、余额、哪些会被拒（免费，不提交）。
2. 把估价原样告诉用户，取得明确确认。
3. `quriov batch submit items.jsonl --yes --json`：打印批次号（`batch_ids`）和每条的 `job_id` / 状态 / 被拒原因。条目多时自动每次最多 50 条分组交，全部归在同一个批次下。
4. `quriov batch status <批次号> --wait --download ./out --json`：等到全部结束，结果图存成 `out/<tag>/<模板>.png`（结果云端只留 1 天，尽快下载）。
5. 汇报：成功 / 部分成功 / 失败的条目（附中文原因），`settled_credits` 实扣合计（只扣真正出来的图）。

**不会重复扣钱**：没填 `idempotency_key` 时按条目内容自动算，同一个文件原样重跑，服务端认出来直接返回原任务。所以中途断了、超时了、余额不足充值后，**原样重跑同一条命令**即可接着交完。真想把同一份内容再出一遍，就改内容或给一个新的 `idempotency_key`（会再花钱，先估价再确认）。

单个任务：`quriov jobs get <job_id>`；一串：`quriov jobs query <id...>`；历史：`quriov jobs list --tag SKU123 --status failed --all`；取消排队中的：`quriov jobs cancel <job_id>`（已在生成的不能取消）。

## 聊天里出图 / 出视频（MCP）

1. 调 `list_capabilities`，从返回的模型和模板里选（以实时结果为准，别凭记忆写模型名）。
2. 整理 prompt 和选项（`aspect_ratio`、`template_id`、`batch_size` 1–4）；有参考图时放进 `input_media`。
3. 调 `estimate_cost`，把点数告诉用户并取得确认。`batch_size` 为 4 就是 4 张的钱。
4. 为这次请求生成稳定且唯一的 `idempotency_key`，调 `generate_image`（视频用 `generate_video`）。
5. 记下返回的 `generation_id`，用 `check_generation` 轮询到终态；丢了编号用 `list_generations` 找回。
6. 只展示工具返回的结果；没有媒体链接时不从别处补，不编造链接。

**状态别看错**：`request_status=succeeded` 只表示任务**收下了**；`status` 才是生成进度（`queued` → `running` → `succeeded`）。只有 `status=succeeded` 时 `media` 里才有图。轮询时只给用户一句简短进度，不刷原始 JSON。

**取消**：以 `cancel_generation` 的返回为准；很多任务提交后就不能取消，所以提交前把模型、张数、点数说清楚。

## MCP 里用本地参考图

MCP 是远程服务，读不到用户电脑上的文件、聊天里的图片或本地预览链接。先用命令行上传换成链接：

```bash
quriov upload ./ref-front.jpg ./ref-side.jpg
```

每个文件打印一个 24 小时有效的 https 链接，作为 `{"type": "image_url", "value": "<链接>"}` 放进 `input_media`。只收 JPG / PNG / WebP，单张不超过 10 MB。只传用户明确给的图。

## 多图套组（聊天里）

先和用户确认模块清单（主图、场景图、细节图……），再为每个模块分别提交：共用产品事实与视觉方向，每个模块的 prompt 只改版式目标；每个模块用不同的 `idempotency_key`；分别记编号、分别轮询；个别失败不冒充整套成功，列清成功、失败和仍在跑的。模块多或要落到文件夹时改用 `quriov batch`。

## Prompt 最低要求

- 写清主体、场景、构图、镜头、光线、材质、色彩与比例。
- 参考图只作为用户明确授权的主体 / 风格输入，不推断或泄露隐藏信息。
- 电商套组保持产品事实、品牌色与视觉语言一致；不同图位避免重复构图。

## 出错时

- 把报错里的中文原因原样告诉用户，连同错误码（error_code）和请求编号（request_id），方便管理员查。
- 连不上、钥匙不对、MCP 工具不见了：运行 `quriov doctor`，按它的提示处理（多数是重跑 `quriov setup`）。
- 余额不足：请用户充值后再 `resume`（`batch submit` 则是原样重跑同一条命令）。
- `503` 命令行会按服务端给的等待时间自动重试几次；其余错误不自动重试，按原因处理后再跑。
