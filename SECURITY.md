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
