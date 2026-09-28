# quriov 命令行（中文说明）

`quriov` 是 Quriov 的官方命令行，**和 Quriov MCP 用同一把钥匙、打同一个后端**。扣点、失败退款、限流、出图记录都在服务端；命令行只做本机的事：

- 读本地参考图并自动上传；
- 按一张表批量提交，自己控速，不会撞服务端的每分钟上限；
- 等结果、把图下载到 `输出目录/货号/图位.png`；
- 写出 `cost.csv`：每个任务花了多少点，**数字直接来自服务端返回**，不按价目表推算；
- 断了能接着跑，已提交的任务用原编号续上，**不会重复扣钱**。

聊天里出一两张图，用 MCP；要批量、要用本地参考图、要把图存进文件夹，用命令行。

## 安装（Mac / Windows 都行）

需要 Node.js 20 或更新版本。

```text
npm install -g github:Quriov/Quriov-MCP#v1.1.0
quriov --help
```

不想全局安装，也可以在本仓检出后直接运行 `node bin/quriov.mjs --help`。零依赖，不会装任何第三方包。

## 一次性准备：钥匙

1. 在 <https://quriovai.com/me/access-keys> 新建一把用途为「MCP」的钥匙（「API 调用」钥匙不行）。
2. 运行 `quriov login`，粘贴钥匙（输入不显示），回车。命令行先验证钥匙能用，再存到本机用户目录：
   - Mac / Linux：`~/.config/quriov/credentials.json`（仅本人可读）
   - Windows：`%APPDATA%\quriov\credentials.json`

也可以不 login，直接设环境变量 `QURIOV_MCP_ACCESS_KEY`。以前用过的名字 `QURIOV_MCP_KEY`、`QURIOV_ACCESS_KEY` 也认，已经配好的不用改。

出于安全，**钥匙不能写在命令参数里**（会留在命令历史和进程列表里），命令行会直接拒绝 `--key` 之类的参数。

## 常用命令

```text
quriov account          # 余额、今天还能提交几次
quriov models           # 能用的模型、模板编号、每张多少点（服务端按你的账号估价）
quriov doctor           # 只读自检：连得上、8 个工具齐全、钥匙可用

# 单张 / 小批：一个提示词、两张参考图、出 4 张
quriov gen -m gpt-image-2.5-2K -p "白底主图，正面平铺" --ref a.jpg --ref b.jpg -n 4 -o ./out
```

## 批量：20 个商品 × 每个 9 张

### 1. 准备一张表

`products.csv`（第一行是表头，每行一个商品；Excel 另存为 CSV UTF-8 即可）：

```text
sku,refs,templates,prompt,model,aspect_ratio,n
A001,refs/A001-front.jpg;refs/A001-side.jpg,main_image;tk_main_image;infographic_1;...,红色 316 不锈钢保温杯 500ml,gpt-image-2.5-2K,,1
A002,refs/A002.jpg,main_image;tk_main_image;infographic_1;...,蓝色玻璃水杯 350ml,gpt-image-2.5-2K,,1
...（共 20 行）
```

| 列 | 意思 |
| --- | --- |
| `sku` | 货号，也是输出子文件夹的名字（必填） |
| `refs` | 参考图，分号隔开，路径相对这张表所在的文件夹 |
| `templates` | 图位模板编号，分号隔开；**每个模板 = 一个图位 = 一次提交**。编号用 `quriov models` 查 |
| `prompt` | 商品描述（必填；模板会自动接在它前面） |
| `model` | 模型，可以不填，改用命令里的 `-m` |
| `aspect_ratio` | 比例，如 `1:1`、`3:4`；不填就用模板自己的比例 |
| `n` | 每个图位出几张（1–4，默认 1） |

中文表头也认：`货号,参考图,模板,提示词,模型,比例,张数`。

`examples/products.csv` 是一个能直接照着改的例子。

也可以用**文件夹模式**：每个子文件夹是一个商品（文件夹名当货号），里面的图当参考图，可放一个 `prompt.txt`；图位用 `--templates` 指定：

```text
quriov batch plan ./products/ -m gpt-image-2.5-2K --templates main_image,tk_main_image,infographic_1
```

### 2. 先看计划（不联网、不花钱）

```text
quriov batch plan products.csv -m gpt-image-2.5-2K
```

会列出每个商品每个图位、共多少次提交、多少张；表里有问题（参考图找不到、提示词为空或超过 8000 字、张数不对、图位重复）会一次全列出来，一张都不会提交。

加 `--estimate` 联网估价（免费，不出图）：总点数、当前余额、今天还能提交几次。

### 3. 确认后提交

```text
quriov batch run products.csv -m gpt-image-2.5-2K -o ./out
```

先联网校验（模型能用、模板编号存在）并给出估价，问你确认；在 AI 或脚本里用时，先 `plan --estimate` 给人看，人点头后加 `--yes`。

跑完的样子：

```text
out/
  A001/main_image.png
  A001/tk_main_image.png
  ...
  cost.csv            # 每个任务一行：货号、图位、模型、张数、点数（服务端返回）、状态、文件、原因；最后一行合计
  .quriov/<批次号>.json  # 进度存档，续跑用，别手改
```

`cost.csv` 带 BOM，Windows 上用 Excel 直接打开中文不乱码。

### 4. 看进度 / 接着跑

```text
quriov batch status <批次号或输出目录>
quriov batch resume <批次号或输出目录>
quriov batch resume ./out --retry-failed     # 把失败的换新编号重交（会再花钱，先估价再确认）
```

每一步都先存盘再做，所以不管是 Ctrl+C、断网还是电脑睡着，`resume` 都能接上：

- 已提交的任务不会重新提交，只继续等结果、下载；
- 发出去但没收到回应的任务，用**原来的任务编号**重交，服务端认得出，不会再扣一次；
- 图已生成但下载失败的，会重新取链接再下（结果在云端只留 1 天，别隔太久）。

## 现在的限制（服务端没改之前）

- 每把钥匙每分钟 30 次请求。MCP 每调一次工具服务端算 2 次，所以命令行默认只用 26 次/分，自动排队。
- 每人每天 100 次提交，**按次不按张**。20 个商品 × 9 个图位 = 180 次，一天交不完：用完时命令行会暂停（退出码 4），已经提交的照常等完、下载完，没提交的留着，第二天 `resume` 接着跑。
- 一次提交最多 4 张、一个模板；每个组织同时出图 4 张，单张约一分半，多交只是在服务端排队（`--concurrency` 默认 4）。
- 服务端查进度只能看最近 50 条记录。命令行一次只挂 4 个在等，所以正常不会超出；如果同一把钥匙同时在别处大量提交，可能有任务被挤出窗口，会标成失败并说明原因。

这些限制会在后端第二步（批量提交 / 按张算配额 / 按编号查询）后放宽，到时命令行会切到新接口。

## 报错怎么看

命令行尽量把真实原因说出来。几个常见的：

| 看到 | 实际原因 | 怎么办 |
| --- | --- | --- |
| 钥匙没通过验证（401），第一次就出现 | 钥匙填错 / 已撤销 / 用途选成了「API 调用」 | 网页上检查或新建「MCP」钥匙，再 `quriov login` |
| 401，但钥匙刚才还能用 | 触发了每分钟上限（服务端目前把限流也报成 401） | 命令行会自动等一分钟重试；还不行过几分钟 `resume` |
| 今天的提交次数用完了 | 每人每天 100 次 | 明天 `resume` |
| 余额不足 | 账户点数不够 | 充值后 `resume` |
| 模板编号不存在 / 模型不可用 | 写错或已下架 | `quriov models` 看能用的 |
| 请求被网站防火墙拦下（1010） | 按请求特征拦的，不是钥匙问题 | 把完整报错发给 Quriov 管理员 |

退出码：`0` 全部完成，`1` 出错，`2` 用法不对，`3` 有任务失败，`4` 暂停（限额 / 网络），可 `resume`。
