---
name: quriov
description: 用 Quriov 出图出视频：聊天里出一两张走 Quriov MCP 工具；批量（多个货号 × 多个图位）、本地参考图、要把图存进文件夹走命令行 quriov。用户要生成商品图、电商套图、带参考图出图、批量出图或生成视频时使用。
---

# Quriov 出图 / 出视频

MCP 工具（名为 `quriov` 的 MCP 服务）和命令行 `quriov` 用**同一把钥匙**、打**同一个后端**，扣费、作品库都一样。区别只在谁来干活：

| 场景 | 用什么 |
|---|---|
| 批量（多个货号 × 多个图位）、要把图下载到本地文件夹、要一张费用清单 | 命令行 `quriov batch` |
| 本地参考图（尤其是真实照片） | 命令行 `quriov gen --ref` / `quriov batch`（自动上传）；或先 `quriov upload` 换成链接再给 MCP |
| 聊天里出一两张、边看边改；出视频 | MCP 工具 |

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

- 把报错里的中文原因原样告诉用户；有请求编号（request_id）就一起报出来，方便管理员查。
- 连不上、钥匙不对、MCP 工具不见了：运行 `quriov doctor`，按它的提示处理（多数是重跑 `quriov setup`）。
- 余额不足：请用户充值后再 `resume`。
