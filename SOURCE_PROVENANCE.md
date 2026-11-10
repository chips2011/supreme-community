# Source provenance

Version baseline: Supreme 0.1.119.

Original source release commit: `c9532426bac16be966e4ecaf2aedf2cf3cf33bd0`.
Community export prepared November 10, 2026 with fresh Git history.

Included: the macOS Electron shell, local Node service, React/TypeScript client,
supporting libraries, optional service/schema source and selected verification
tools. The later dedicated Agents UI, rebake and Apex deal-agent code are outside
this release. The native iOS project is also outside this desktop export.

Publication changes:

- Added Apache-2.0 licensing, third-party notices and public contributor docs.
- Replaced internal handoff notes and removed manual live replay tools.
- Replaced personal/contact examples with synthetic fixture identities.
- Removed checked-in generated bundles, source maps and provider logo artwork.
  The web client builds from source; provider controls use text labels.
- Disabled analytics hooks and removed the production analytics dependency.
- Made optional account configuration empty by default, removed a production
  Slack redirect fallback, and stopped copying Slack secrets into app bundles.
- Set community defaults to port 4757, `~/.supreme-community`, a separate desktop
  identity/profile and cloud Keychain namespace, and no official URL-scheme or updater registration by default.
- Added offline test entry points, publication checks and CI.

These changes preserve the original product baseline while making an independent
community build practical. They mean a community build is not byte-identical to
the existing signed installer. The installer at meetsupreme.com remains 0.1.119.
