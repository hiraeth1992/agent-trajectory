## Summary

Describe the user-visible change and why it is needed.

## Security and privacy

- [ ] Source access remains read-only.
- [ ] Loopback, opaque-ID, and redaction boundaries remain intact or are
      intentionally strengthened.
- [ ] The change contains no real agent sessions, credentials, private prompts,
      proprietary source code, personal information, local paths, or generated
      real-source evidence.

## Verification

- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm audit --omit=dev --audit-level=high`

List any additional manual or platform-specific checks:
