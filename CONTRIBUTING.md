# Contributing to Agent Trajectory

Thanks for helping improve Agent Trajectory.

Participation in this project is governed by the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Development setup

Use Node.js 22.12 or newer:

```bash
npm ci
npm run dev
```

Before submitting a change, run:

```bash
npm test
npm run build
npm audit
```

## Change guidelines

- Keep all source adapters read-only. Do not add writes, hooks, injection, or
  decryption against DSH, Codex, or ZCode.
- Preserve opaque session routing and loopback-only HTTP access.
- Add or update tests for behavior changes, especially parsing, projection,
  redaction, source isolation, and cache invalidation.
- Use synthetic fixtures. Do not commit real agent sessions, local paths,
  credentials, private prompts, proprietary source code, or generated
  `evidence/real-source-verification.json`.
- Keep source-specific parsing in `server/sources` or `server/projectors` and
  expose only shared, evidence-backed facts through the unified model.
- Keep pull requests focused and explain user-visible changes, security
  implications, and verification performed.

## Reporting security issues

Do not disclose suspected vulnerabilities or sensitive sample data in a public
issue. Follow the private reporting instructions in
[`SECURITY.md`](SECURITY.md).

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
