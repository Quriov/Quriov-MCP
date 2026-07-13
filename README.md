# Quriov MCP

Official installation and validation recipes for the Quriov remote MCP.

Quriov MCP lets a trusted coding agent inspect the available image and video
generation capabilities, estimate a job, generate media after confirmation,
and check or cancel the resulting task. The hosted service is operated at:

```text
https://quriovai.com/mcp/v1
```

This repository is the public distribution layer for client setup and
read-only validation. It is not the MCP server source, a plugin, or a general
installer.

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
