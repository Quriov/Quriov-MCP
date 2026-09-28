# Quriov MCP

Official installation and validation recipes for Quriov MCP.

Quriov MCP lets a trusted coding agent inspect the available image and video
generation capabilities, estimate a job, generate media after confirmation,
and check or cancel the resulting task. The hosted service is operated at:

```text
https://quriovai.com/mcp/v1
```

This repository is the public distribution layer for client setup,
read-only validation, and the official `quriov` command-line tool. It is not
the MCP server source, a plugin, or a general installer.

## 命令行 quriov（批量出图）

和 MCP 同一把钥匙、同一个后端。聊天里出一两张用 MCP；批量、用本地参考图、要把图存进文件夹，用命令行。完整中文说明见 [`CLI.md`](CLI.md)。

```text
# 需要 Node 20+，Mac / Windows 都行；npm 10 / 11 / 12 都能直接装
npm install -g https://github.com/Quriov/Quriov-MCP/releases/download/v1.1.1/quriov-mcp-distribution-1.1.1.tgz
quriov login                                      # 粘贴网页上建的「MCP」钥匙（不回显）

# 20 个商品 × 每个 9 个图位：一张表，每行一个商品
quriov batch plan products.csv -m gpt-image-2.5-2K --estimate   # 只估价，不花钱
quriov batch run  products.csv -m gpt-image-2.5-2K -o ./out     # 确认后提交、等结果、下载
quriov batch resume ./out                                       # 断了接着跑，不重复扣钱
```

结果在 `out/<货号>/<图位>.png`，每个任务花了多少点在 `out/cost.csv`（数字来自服务端返回）。

## Before you install

- Create a dedicated `scope=mcp` access key at
  [quriovai.com/me/access-keys](https://quriovai.com/me/access-keys).
- Use a separate key for each client or device so it can be revoked without
  disrupting other clients.
- If you paste a key into Codex, Claude Code, Cursor, or another agent, that
  agent's provider, model, and chat history can see it. Only use a personal,
  trusted session. Never send the key to a public or shared task.
- A Quriov MCP key can be revoked from the website at any time. Revocation and
  client uninstall are separate actions.

## Verified client capability matrix

Checked against official documentation and local client spikes on 2026-07-14.
Unverified items are intentionally not described as automatic installation.

| Client | Official capability | Local spike | Product wording |
| --- | --- | --- | --- |
| Codex Desktop / CLI / IDE | The clients share `~/.codex/config.toml`; Streamable HTTP supports bearer auth, static `http_headers`, and environment-backed headers. Desktop and IDE require a restart after configuration. | `@openai/codex` `0.144.3`: isolated add/get/list/remove passed. Windows Codex App package `26.707.8479.0` was detected, but its bundled CLI could not be launched from the shell because of WindowsApps ACLs. | Trusted-agent installation is supported. App-shell command execution remains `unverified`; restart the app or extension. |
| Claude Code | Remote HTTP, static headers, `user` scope, list/get/remove, and `/mcp` status are documented. | Claude Code `2.1.207`: user-scope add/get/remove passed with a disposable invalid credential and left no spike entry behind. | Trusted-agent installation is supported. |
| Cursor | Global `~/.cursor/mcp.json`, header interpolation, Streamable HTTP, MCP approval, CLI list, and CLI list-tools are documented. | No Cursor or Cursor Agent executable was installed on the verification machine. | AI-assisted configuration only; automatic installation is `unverified`. |

Primary sources:

- [OpenAI Codex MCP documentation](https://developers.openai.com/codex/mcp/)
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
- [Cursor MCP documentation](https://cursor.com/docs/mcp)
- [Cursor CLI parameters](https://docs.cursor.com/en/cli/reference/parameters)

## Public contract

- One remote endpoint: `https://quriovai.com/mcp/v1`.
- Authentication: a revocable Quriov `scope=mcp` access key.
- Exactly eight tools:
  `cancel_generation`, `check_generation`, `estimate_cost`, `generate_image`,
  `generate_video`, `get_account`, `list_capabilities`, and
  `list_generations`.
- Client recipes may write only the named client's user-scope MCP
  configuration and credential reference.
- The doctor is read-only. It initializes the server, checks the exact tool
  contract, and calls `get_account` without printing account data.
- The CLI uses the same key and the same eight tools, plus
  `https://quriovai.com/api/v1/mcp/uploads` for local reference images. It
  downloads results from the presigned URLs the tools return, without sending
  the key.

## Repository map

- [`AGENTS.md`](AGENTS.md): safety and contribution contract for agents.
- [`llms.txt`](llms.txt): compact machine-readable index.
- [`recipes/codex.md`](recipes/codex.md): pinned Codex install, verify, and
  uninstall recipe.
- [`recipes/claude-code.md`](recipes/claude-code.md): pinned Claude Code
  install, verify, and uninstall recipe.
- [`recipes/cursor.md`](recipes/cursor.md): Cursor AI-assisted configuration;
  automatic installation remains `unverified`.
- [`install-manifest.json`](install-manifest.json): release contract and
  SHA-256 locks for every install input.
- [`contract.lock.json`](contract.lock.json): non-authoritative public snapshot
  of the fixed endpoint and exact eight-tool contract.
- [`bin/quriov-mcp-doctor.mjs`](bin/quriov-mcp-doctor.mjs): read-only protocol
  doctor, covered by Node tests.
- [`bin/quriov.mjs`](bin/quriov.mjs): official zero-dependency CLI, covered by
  Node tests with a mocked HTTP layer. Chinese guide: [`CLI.md`](CLI.md);
  example batch spec: [`examples/products.csv`](examples/products.csv).
- [`SECURITY.md`](SECURITY.md): private reporting path and threat model.

After checking out the commit or tag supplied by the Quriov website and
verifying the supplied manifest hash, run the doctor without putting the key
in a command-line argument:

```text
node bin/quriov-mcp-doctor.mjs --key-stdin
```

The doctor reports only stage status, the exact tool count, and a redacted
`get_account` result. It does not install, modify configuration, generate,
spend credit, or revoke a key.

## License

The public installation and validation material in this repository is released
under the [MIT License](LICENSE).
