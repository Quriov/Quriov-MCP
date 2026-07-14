# Cursor user-scope recipe

Support level: **AI-assisted configuration; automatic installation is
unverified**.

Cursor documents global `~/.cursor/mcp.json`, Streamable HTTP, header
interpolation, approval, `agent mcp list`, and `agent mcp list-tools`. No Cursor
or Cursor Agent executable was installed on the 2026-07-14 verification
machine, so this recipe must not claim an automatic install.

## Inputs supplied by the Quriov website

- `RELEASE_COMMIT`: immutable commit in `Quriov/Quriov-MCP`.
- `MANIFEST_SHA256`: expected SHA-256 of `install-manifest.json` at that commit.
- `QURIOV_MCP_KEY`: dedicated revocable `scope=mcp` key.

Treat `QURIOV_MCP_KEY` as a secret already disclosed to this trusted agent
session. Do not repeat it in chat or place it in a command, URL, log, Git diff,
issue, or process argument.

## Assist the user

1. Fetch `Quriov/Quriov-MCP` at exactly `RELEASE_COMMIT`. Do not use `main` or
   another mutable ref.
2. Hash `install-manifest.json` and stop unless it equals `MANIFEST_SHA256`.
3. Read `AGENTS.md`, this recipe, and the manifest before changing client state.
4. Report the installed Cursor or Agent version. If neither client is present,
   stop and report `unverified`; do not install Cursor on the user's behalf.
5. Inspect `~/.cursor/mcp.json` and the current client's MCP configuration help.
   Preserve every unrelated setting. If the file cannot be parsed safely, stop.
6. Confirm the installed version accepts a global Streamable HTTP server with a
   static `Authorization` header before writing the key. If that exact behavior
   cannot be proved, keep the result `unverified` and offer the documented
   environment-header path as the optional professional fallback.
7. Only after step 6 is proved, add or replace the user-scope `quriov` entry for
   `https://quriovai.com/mcp/v1` using a secret-safe structured edit.
8. Restart or reload Cursor when requested, approve the server, then run
   `agent mcp list` and `agent mcp list-tools quriov` (or the equivalent command
   shown by the installed client).
9. Run the pinned doctor from the checked-out commit. Supply the key through
   stdin or a transient environment value, never as an argument.

## Expected doctor result

- initialize: PASS
- exact eight tools: PASS
- redacted `get_account`: PASS

Until the real client spike passes, report `AI-assisted / unverified` rather
than claiming installation succeeded.

## Uninstall

1. Remove only the `quriov` entry from `~/.cursor/mcp.json`.
2. Reload Cursor and confirm `agent mcp list` no longer shows Quriov.
3. Remove the Quriov credential reference used by that entry and confirm the
   key value is absent from the user config.

Uninstall does not revoke the key. Revoke it separately from the Quriov access
key page, then confirm a new connection returns HTTP 401 when testing revocation.
