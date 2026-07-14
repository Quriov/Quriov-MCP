# Claude Code user-scope recipe

Support level: **trusted-agent installation**.

Verified on 2026-07-14 with Claude Code `2.1.207`: remote HTTP, static headers,
user scope, add/get/list/remove, and `/mcp` status are available.

## Inputs supplied by the Quriov website

- `RELEASE_COMMIT`: immutable commit in `Quriov/Quriov-MCP`.
- `MANIFEST_SHA256`: expected SHA-256 of `install-manifest.json` at that commit.
- `QURIOV_MCP_KEY`: dedicated revocable `scope=mcp` key.

Treat `QURIOV_MCP_KEY` as a secret already disclosed to this trusted agent
session. Do not repeat it in chat or place it in a command, URL, log, Git diff,
issue, or process argument.

## Install

1. Fetch `Quriov/Quriov-MCP` at exactly `RELEASE_COMMIT`. Do not use `main` or
   another mutable ref.
2. Hash `install-manifest.json` and stop unless it equals `MANIFEST_SHA256`.
3. Read `AGENTS.md`, this recipe, and the manifest before changing client state.
4. Inspect the user-scope Claude configuration in `~/.claude.json`. Preserve
   every unrelated setting. If it cannot be parsed safely, stop without
   modifying it.
5. Add or replace only the user-scope MCP server named `quriov` with this
   logical shape:

   ```json
   {
     "type": "http",
     "url": "https://quriovai.com/mcp/v1",
     "headers": {
       "Authorization": "Bearer <QURIOV_MCP_KEY>"
     }
   }
   ```

   Use a secret-safe structured edit. Do not call `claude mcp add --header`
   with the real key because command arguments can be recorded by the shell or
   process monitor.
6. Start a new Claude Code session and use `/mcp` to confirm the user-scope
   `quriov` server connects. Do not run a configuration dump that could print
   static header values.
7. Run the pinned doctor from the checked-out commit. Supply the key through
   stdin or a transient environment value, never as an argument.

## Expected doctor result

- initialize: PASS
- exact eight tools: PASS
- redacted `get_account`: PASS

The doctor must not print the key or any account value.

## Uninstall

1. Run `claude mcp remove --scope user quriov`, or remove only the `quriov`
   user-scope server with a safe structured edit.
2. Confirm `/mcp` no longer lists the server.
3. Confirm no Quriov credential remains in `~/.claude.json`.

Uninstall does not revoke the key. Revoke it separately from the Quriov access
key page, then confirm a new connection returns HTTP 401 when testing revocation.
