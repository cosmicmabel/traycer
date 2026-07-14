# Security Policy

CIC is local-only software: the host server binds `127.0.0.1` and the stack
makes no outbound connections. Even so, bugs that let a malicious workspace,
crafted file, or network peer escape those boundaries are security bugs.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub
issues. Instead, use
[GitHub private vulnerability reporting](https://github.com/cosmicmabel/traycer/security/advisories/new)
for this repository. Reports are triaged on a best-effort basis.

## Scope notes

- The web serve port is an unauthenticated door to the local host by
  design; exposing it beyond `127.0.0.1` is an explicit operator choice
  (`--bind`). Issues that require the operator to have opted into an
  untrusted network are still worth reporting, but say so in the report.
- Provider API keys entered in Settings are stored in plaintext under
  `~/.cic` (documented behavior, single-user machine model).
