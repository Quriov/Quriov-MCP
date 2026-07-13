# Security policy

## Reporting a vulnerability

Please use the private
[GitHub Security Advisory form](https://github.com/Quriov/quriov-mcp/security/advisories/new)
for suspected vulnerabilities. Do not open a public issue for a security
report, and never include an access key, credential, account response, or
private configuration in a report.

If a credential may have been exposed, revoke that dedicated key immediately
from the Quriov website, then create a replacement for the affected client.
Removing a client configuration does not revoke its key.

## Distribution threat model

This repository deliberately contains no MCP server implementation or
privileged operational material. Its install contract limits agents to one
fixed HTTPS endpoint and the selected client's user-scope configuration.
Install prompts must pin a reviewed release or commit and the SHA-256 of
`install-manifest.json`; mutable branch content is not an installation source.

The doctor is read-only. It may initialize the fixed endpoint, list the exact
eight public tools, and call `get_account`, but it must not print account data,
write configuration, generate media, spend credit, or revoke credentials.

## Public information boundary

Reports and fixes must not publish provider routing, internal prompts,
infrastructure details, prices, profit data, raw upstream responses, or private
Registry metadata. The public contract in `contract.lock.json` is a
non-authoritative compatibility snapshot only.
