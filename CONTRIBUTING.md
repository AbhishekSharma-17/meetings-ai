# Contributing to Meetings AI

Thank you for helping improve Meetings AI. Start with the [README](README.md), [self-hosting guide](docs/deployment/self-hosting.md) and current code. For significant architectural changes, open an issue first describing the problem, scope, privacy implications and proposed validation.

## Local development

Clone with `--recurse-submodules`; use Node.js 22+ and Python 3.12+. Follow the README to create an ignored `.env.local`, install dependencies and start local services. Never use production accounts, recordings or API keys as fixtures.

Read applicable `AGENTS.md` and `CLAUDE.md` files before agent-assisted changes. In particular, the frontend requires checking bundled Next.js documentation rather than assuming an older API version.

Useful checks from the repository root:

```sh
make api-test
make web-check
npm --prefix apps/web run test:e2e
```

Install Playwright browsers from `apps/web` when necessary. Use mocked integrations for automated tests; a live meeting, OAuth flow, email send or destructive cleanup requires explicit operator authorization. Report which tests passed, which were skipped and whether an external outcome was actually witnessed.

## Pull requests

- Keep changes focused, explain user-visible behavior and link the related issue.
- Preserve unrelated worktree edits and upstream/submodule notices.
- Include regression tests, accessibility/responsive checks for UI changes, and permission-denial tests for tenant-sensitive changes.
- For schema changes, add an explicit numbered migration, test existing-data preservation and document backup/recovery implications. Do not silently stamp a schema or rely on `create_all` as a migration.
- Keep provider agnosticism, explicit recording consent, approval-before-send and source-backed claims intact.
- Never introduce browser-visible credentials or log complete provider/auth responses.
- Document operational changes and distinguish implementation from live validation.

## Contribution licensing

By intentionally submitting a contribution for inclusion, you agree to license it under Apache License 2.0 as described by Section 5 of [LICENSE](LICENSE), unless a separate agreement applies. Only submit material you have the right to contribute. No copyright assignment or additional CLA is introduced by this guide.

Credit third-party material, retain its original license/notice and identify changes. Dependency additions need a license/provenance review; model weights and image-baked artifacts require separate consideration.

## Community and support

Be respectful, constructive and specific. Do not publish other people's identities or meeting content. Public issues are for bugs and feature proposals, not secrets or vulnerability details. Report security concerns using [SECURITY.md](SECURITY.md). Maintainer review and support are best-effort; there is no guaranteed response SLA.
