# Security policy

## Reporting a vulnerability

Do not post vulnerabilities, credentials or private meeting data in public issues. If GitHub private vulnerability reporting is enabled, use the repository's **Security → Report a vulnerability** flow. Otherwise contact **developer@genaiprotos.com** privately with a concise summary; coordinate a secure channel before sending sensitive evidence.

Include the affected commit/deployment, reproduction steps using synthetic data, potential impact and any proposed fix. Avoid testing on other users or organizations, joining calls without consent, sending unsolicited email or accessing data outside your authority. Do not include live access tokens in screenshots.

Maintainers will review reports on a best-effort basis. No response or remediation SLA is promised. Coordinate disclosure rather than publishing exploitable details immediately.

## Supported versions

There is currently no stable-release/LTS support policy. Security fixes target the maintained `main` branch. Operators should pin and track reviewed commits and image digests, and verify upgrades before applying them.

## Deployment boundaries

- Use HTTPS and keep API, Vexa, databases and management consoles private.
- Generate separate admin, session, credential-encryption and signed-STT secrets. Never use development fallback keys in production.
- Preserve the encryption key securely; rotating it requires re-encrypting stored credentials or reconfiguring providers.
- Rotate any credential previously posted in a chat, log, issue or commit. Deleting the text is not sufficient remediation.
- Limit provider scopes and tool execution. Calendar invitees and speaker labels are not verified identity.
- Obtain recording consent and review recap recipients before sending. Provider calls can transmit private content; evaluate their retention/data terms.
- Back up the database, test restores and define retention for backups separately from application deletion.
- Application-level tenant checks are not a substitute for security testing, database policy review or a complete multi-tenant audit.
- Restrict logs/artifacts/exports to authorized operators; sent email and downloaded copies cannot be recalled.

See [the secrets runbook](docs/security/secrets.md) and [release checks](docs/deployment/self-hosting.md#release-checklist). This policy is not a security certification or guarantee.
