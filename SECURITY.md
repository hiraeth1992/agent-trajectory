# Security Policy

## Supported versions

Security fixes are provided for the latest version on the default branch.

## Reporting a vulnerability

Use the repository host's private vulnerability reporting feature when it is
enabled. On GitHub, open the repository's **Security** tab and select
**Report a vulnerability**.

If private reporting is unavailable, open a public issue containing only a
request for private contact and no vulnerability details or sensitive data.
Repository maintainers can then establish a private channel. This project
intentionally does not publish a personal email address.

Include the affected version, impact, reproduction steps, and a minimal
synthetic example. Do not attach:

- real DSH, Codex, or ZCode sessions;
- credentials, cookies, tokens, certificates, or model request headers;
- private prompts, proprietary source code, or unredacted audit exports;
- local usernames, home-directory paths, or generated real-source evidence.

Please allow maintainers a reasonable period to investigate and release a fix
before public disclosure.

## Security boundary

Agent Trajectory is designed to read local agent data without modifying its
source. The server must remain bound to a loopback address, reject non-local
requests, treat session identifiers as opaque values, open source databases
read-only, and redact sensitive fields at projection and export boundaries.

Ordinary browsing, projection, diagnosis, calibration, and evaluation keep
that read-only boundary. The explicit `install-hooks` and `uninstall-hooks`
commands are the sole exception: after a direct user command, they may
transactionally add or remove only Agent Trajectory-marked activation entries
in local Agent configuration. They do not modify session content or execute
Agent tools, and a partial failure must roll back every touched file.

AI Summary credentials use AES-256-GCM and private `0600` files. The encryption
key and ciphertext are stored under the same local data root. This protects
against accidental plaintext disclosure and ciphertext-only leakage; it does
not protect against an attacker who can read the entire data directory as the
same operating-system account. High-sensitivity deployments should avoid
storing a key or use an operating-system credential store when one is added.

Private calibration candidates, reviewer files, adjudication, EvaluationRuns,
and the badcase casebook remain local files. Hash binding detects replacement
or mismatch but is not access control or encryption. The `independent`
restriction is an evaluation protocol; strong sealing requires a separately
designed reviewer identity, key custody, and unlock workflow.
