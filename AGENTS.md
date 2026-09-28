# Quriov MCP public distribution rules

This repository contains public installation and validation material only. It
must remain safe to read and execute in an untrusted checkout.

## Fixed boundaries

- The only API network targets are `https://quriovai.com/mcp/v1` and, for the
  official CLI's reference-image upload only,
  `https://quriovai.com/api/v1/mcp/uploads`. The CLI may additionally GET the
  presigned `https` result URLs returned by the MCP endpoint, and must never
  send the key to them.
- The runtime contract is exactly eight tools. Do not add, remove, rename, or
  dynamically filter tools here.
- `bin/quriov.mjs` is the single-file official command-line tool. It uses Node
  built-ins only (no dependencies), speaks MCP JSON-RPC to the fixed endpoint,
  and keeps all billing, quota, and routing on the server. Costs it reports must
  come from API responses, never from a local price list.
- Do not add MCP server source, provider routing, prices, internal prompts,
  infrastructure, deployment instructions, or operational secrets.
- Do not turn this repository into an MCP server, plugin, SDK, background
  daemon, universal installer, or auto-updater. The CLI runs only in the
  foreground on the user's explicit command.
- Do not copy or publish the private Registry `server.json`. Registry identity
  and runtime implementation remain authoritative elsewhere.

## Secret handling

- Never commit a real access key or any other credential.
- Never put a key in a URL, command-line argument, process listing, log,
  analytics event, test fixture, issue, pull request, or generated report.
- Recipes use placeholders only. A trusted agent may receive a key from its
  user and keep it transiently in memory or stdin while writing the selected
  client's user-scope configuration.
- Doctor output must redact account data, upstream responses, and the key.
- The CLI reads the key only from `QURIOV_MCP_ACCESS_KEY` (legacy names
  `QURIOV_MCP_KEY` and `QURIOV_ACCESS_KEY` are accepted), stdin, or the file
  written by `quriov login` in the user's config directory. It rejects key and
  endpoint command-line arguments and never writes the key into batch state,
  cost lists, or output.
- Revocation happens only in the Quriov website. Uninstall removes only the
  selected client's user-scope Quriov configuration and credential reference.

## Immutable installation contract

- A key-bearing installation prompt must pin an audited commit or release tag
  and its SHA-256 manifest hash. Never install from a mutable branch such as
  `main`.
- Recipes may modify only the user-scope configuration paths they name.
- Recipes must show their planned path and network target before changing
  state, preserve unrelated configuration, and stop if the existing file
  cannot be parsed safely.
- The doctor never installs, edits configuration, generates media, spends
  credit, revokes a key, or follows arbitrary URLs.
- The CLI spends credit only after showing a server-side estimate and getting
  an explicit confirmation (`--yes` in non-interactive use). Its `plan` and
  `--dry-run` modes make no network calls.

## Verification

- Run focused tests before committing and the complete test suite before
  opening a pull request.
- Secret scans and contract checks must fail closed.
- A recipe may claim automatic installation only when current official
  documentation and a real client-version spike both support the claim.
- Keep unsupported or unavailable client behavior labeled `unverified`.
