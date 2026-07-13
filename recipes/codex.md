# Codex user-scope recipe

Support level: **trusted-agent installation**.

Verified on 2026-07-14 with `@openai/codex` `0.144.3`. OpenAI documents
that Codex Desktop, Codex CLI, and the IDE extension share
`~/.codex/config.toml` on the same host.

## Inputs supplied by the Quriov website

- `RELEASE_COMMIT`: immutable commit in `Quriov/quriov-mcp`.
- `MANIFEST_SHA256`: expected SHA-256 of `install-manifest.json` at that commit.
- `QURIOV_MCP_KEY`: dedicated revocable `scope=mcp` key.

Treat `QURIOV_MCP_KEY` as a secret already disclosed to this trusted agent
session. Do not repeat it in chat or place it in a command, URL, log, Git diff,
issue, or process argument.

## Install

1. Fetch `Quriov/quriov-mcp` at exactly `RELEASE_COMMIT`. Do not use `main` or
   another mutable ref.
2. Hash `install-manifest.json` and stop unless it equals `MANIFEST_SHA256`.
3. Read `AGENTS.md`, this recipe, and the manifest before changing client state.
4. Inspect `~/.codex/config.toml`. Preserve every unrelated setting. If the
   file cannot be parsed safely, stop without modifying it.
5. Add or replace only the `quriov` user-scope server with this logical shape:

   ```toml
   [mcp_servers.quriov]
   url = "https://quriovai.com/mcp/v1"
   http_headers = { Authorization = "Bearer <QURIOV_MCP_KEY>" }
   ```

   Use a secret-safe structured edit. The literal key belongs only in the
   user's MCP configuration, never in a shell command or repository file.
6. Restart Codex Desktop or the IDE extension; start a new CLI session. Use the
   client MCP status UI or `/mcp` to confirm `quriov` connects. Do not run a
   configuration dump that could print static header values.
7. Run the pinned doctor from the checked-out commit. Supply the key through
   stdin or a transient environment value, never as an argument.

## Expected doctor result

- initialize: PASS
- exact eight tools: PASS
- redacted `get_account`: PASS

The doctor must not print the key or any account value.

## Uninstall

1. Run `codex mcp remove quriov`, or remove only
   `[mcp_servers.quriov]` with a safe structured edit.
2. Confirm the client MCP status UI no longer lists `quriov`.
3. Confirm no Quriov credential remains in `~/.codex/config.toml`.

Uninstall does not revoke the key. Revoke it separately from the Quriov access
key page, then confirm a new connection returns HTTP 401 when testing revocation.
