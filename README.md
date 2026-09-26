# Meetings AI

<img src="apps/web/public/brand/meetings-ai-avatar-1024.png" alt="Meetings AI logo" width="96" />

**Turn meetings into reviewed minutes, actionable follow-ups, and searchable team knowledge.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Product API](https://github.com/AbhishekSharma-17/meetings-ai/actions/workflows/api.yml/badge.svg)](https://github.com/AbhishekSharma-17/meetings-ai/actions/workflows/api.yml)
[![Web UI](https://github.com/AbhishekSharma-17/meetings-ai/actions/workflows/web-ui.yml/badge.svg)](https://github.com/AbhishekSharma-17/meetings-ai/actions/workflows/web-ui.yml)

Meetings AI is a self-hostable, provider-agnostic meeting workspace maintained by GenAI Protos and contributors. It combines a Next.js interface, a FastAPI API, PostgreSQL persistence, and a pinned [Vexa](https://github.com/Vexa-ai/vexa) capture subsystem.

Connect meeting sources, schedule an assistant, review a timestamped transcript, approve an evidence-backed recap, and build shared knowledge from selected meetings. Cloud AI providers are optional choices, not hardcoded requirements; compatible and local transcription routes remain supported.

[Quick start](#quick-start) · [Configuration](#configuration) · [Deployment](docs/deployment/self-hosting.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Attribution](THIRD_PARTY_NOTICES.md)

## Capabilities

| Area | Available in the application |
| --- | --- |
| Meeting capture | Manual meeting links, Vexa dispatch, lifecycle controls, scheduled calendar joins, durable records |
| Transcript review | Timestamped turns, speaker corrections, explicit speaker-to-email confirmation, export |
| Minutes and follow-up | Automatic post-capture drafts, selectable formats and focus fields, review, approval, delivery retries |
| Email | Branded Resend recaps, internal recipients, explicit participant opt-in, optional Markdown transcript attachment |
| Meeting sources | Multiple Google Calendar, Outlook, Calendly and Zoom connections, account aliases/disconnect, saved calendar snapshots |
| Team workspaces | Email/password accounts, memberships and roles, invitations, first-login password change, workspace switching |
| AI configuration | Named transcription, text-generation and embedding profiles, encrypted server-side credentials, model selection |
| Knowledge | Named bases, explicit opt-in, sharing controls, source-linked wiki views, saved chat and streaming answer endpoint |
| Meeting preparation | Company profile, uploaded context documents, optional public research and saved briefings |
| Operations | Audit/job views, retention controls, token usage and explicitly estimated costs |

### Scope and readiness

This repository contains a working application and deployment configuration, not a guarantee of production readiness for every environment.

- Meet, Zoom and Teams capture depends on platform admission rules, the selected Vexa runtime and host resources. Each platform needs a consented live acceptance test.
- Speaker labels are best-effort capture attribution, not verified identity. Review corrections and confirm email mappings before relying on named claims.
- Invitees are not verified attendees. Email is sent only after explicit review/approval and a send action; calendar sync does not automatically email invitees.
- Semantic retrieval uses context-enriched chunks with pgvector embeddings and HNSW indexes in PostgreSQL, fused with keyword search and re-checked against live access rules (SQLite falls back to in-process scoring).
- The linked wiki combines canonical meeting evidence, explicit relationships and bounded search planning. It is not a fully generated entity graph or unlimited-memory agent.
- Application tenant checks exist; hosted database RLS, comprehensive security/tenant acceptance, account recovery/SSO, distributed jobs and billing remain open work.
- Automated/mocked tests do not establish OAuth consent, diarization quality, live email delivery or retrieval accuracy.
- Current workers require a single API replica. Review the deployment release gates before scaling.

See [acceptance checks](docs/validation/mvp-acceptance.md) and the [deployment checklist](docs/deployment/self-hosting.md#release-checklist). Some historical status documents describe older snapshots; inspect current code when they disagree.

## Architecture

```text
Browser → Next.js web → same-origin /v1 proxy → FastAPI API → PostgreSQL
                                                ├─ Vexa → meeting platform / STT
                                                ├─ selected generation / embedding provider
                                                ├─ Composio → connected meeting sources
                                                └─ Resend → approved email delivery
```

The API owns access checks, credential resolution and provider calls. The browser never receives integration keys or private service URLs. Vexa receives a short-lived signed transcription route for each new bot; changing defaults does not switch an active capture.

| Directory | Purpose |
| --- | --- |
| `apps/web/` | Next.js, React and TypeScript interface |
| `services/api/` | FastAPI, SQLAlchemy, integrations and in-process workers |
| `packages/contracts/` | Provider and meeting contracts |
| `vendor/vexa/` | Pinned capture fork; independent upstream license and notices |
| `deploy/railway/` | Railway Vexa overlay |
| `docs/` | Architecture, deployment, security and validation guides |
| `scripts/` | Supporting evaluation scripts |
| `supabase/` | Supporting scaffolding; not a required hosting service |

## Quick start

### Prerequisites

- Git with submodules, Docker with Compose, and network access to the meeting platforms/providers you select.
- Node.js 22+ and Python 3.12+ for development and tests.
- Sufficient CPU/RAM for browser capture. Vexa Lite supports the ARM64 development path; validate image architecture and concurrency before choosing a host.

### 1. Clone and configure

```sh
git clone --recurse-submodules https://github.com/AbhishekSharma-17/meetings-ai.git
cd meetings-ai
cp .env.example .env.local
```

Edit the ignored `.env.local` before starting. Set a private admin password, session secret, credential encryption key, Vexa API key and shared STT override secret. Generate independent secrets, for example:

```sh
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Run that command separately for each secret. Keep the credential encryption key stable: replacing it without a migration makes stored provider keys unreadable. The admin password seeds an account only once; later password changes are stored in the database.

### 2. Start capture and the application

```sh
make vexa-up
make compose-up
```

Follow the pinned [Vexa Lite instructions](vendor/vexa/deploy/lite/README.md) to initialize its API access and obtain `VEXA_API_KEY`; do not assume the product admin password authenticates Vexa. Update `.env.local` and recreate the product API after changing configuration. The product and Vexa must share `VEXA_STT_OVERRIDE_SECRET`.

Open **http://localhost:3020**. The local API listens on **http://localhost:8320**; `/health` checks process liveness and `/ready` checks database/schema readiness. Local Compose credentials and loopback bindings are for development only.

The default local transcription path uses faster-whisper. For a remote path, follow the Vexa configuration guide and set `VEXA_STT_MODE=remote`; alternatively configure a compatible transcription profile through the product UI. Preserve the local path when adding providers.

### 3. Configure and validate

1. Sign in using your configured admin account and change its password as appropriate.
2. Add transcription, text-generation and embedding profiles in **AI providers**.
3. Optionally connect meeting sources through **Calendar → Integrations**, then sync a bounded date range.
4. Use a meeting whose participants consent to recording. Admit the assistant and announce the disclosure.
5. Review speakers and transcript, generate/review the MOM, and approve before sending a recap.
6. Opt the meeting into a knowledge base, index it, and verify chat citations against the actual transcript.

Recording notice: “Meetings AI has joined and will record and transcribe this conversation.” Operators are responsible for consent, applicable recording rules and their organization's privacy policy.

## Configuration

Use [.env.example](.env.example) as the variable inventory and [the security guide](docs/security/secrets.md) for handling secrets.

| Purpose | Variables / setup |
| --- | --- |
| Runtime and database | `APP_ENV`, `DATABASE_URL`, `WEB_ORIGIN`, `APP_BASE_URL` |
| Admin and sessions | `MEETINGS_AI_ADMIN_EMAIL`, `MEETINGS_AI_ADMIN_PASSWORD`, `MEETINGS_AI_SESSION_SECRET` |
| Stored credentials | `PROVIDER_CREDENTIAL_KEY` |
| Vexa | `VEXA_BASE_URL`, `VEXA_API_KEY`, matching `VEXA_STT_OVERRIDE_SECRET` |
| Model providers | Configure profiles in the UI; credentials remain server-side |
| Calendar discovery | `COMPOSIO_API_KEY` and the selected `COMPOSIO_*_AUTH_CONFIG_ID` values |
| Email | `RESEND_API_KEY`, explicit `RESEND_FROM_EMAIL`, optional sender name |
| Web proxy | `API_INTERNAL_BASE_URL` on the web service |

Some variables apply to standalone/hosted execution; local Compose sets several defaults explicitly. Read `compose.yaml` instead of assuming every `.env.local` variable is forwarded automatically.

Composio-managed OAuth is supported. Google consent can fail when an auth config overrides scopes with ones not verified for the managed client. Use a verified configuration and a fresh app-user connection; default scopes can be broader than the application's read-only behavior. A dashboard test connection is not an application-user connection.

Resend requires an authorized sender domain. A configured sender or accepted request is not proof of inbox delivery. Receiving replies requires a separate mailbox/reply route.

## Deployment

[Self-hosting guide](docs/deployment/self-hosting.md) covers Railway service layout, configuration, migrations, DNS, upgrades and release checks. [Existing deployment runbook](docs/deployment/railway.md) records this project's hosted topology.

Railway can run the complete stack; Vercel and Supabase are not required. Keep API, capture and database services private and expose only the web application. Use production secrets, PostgreSQL, HTTPS, database backups, bounded resource/concurrency limits and a verified sender.

There is no one-click deployment guarantee: Vexa initialization, provider credentials, OAuth configuration and live validation are operator steps.

## Development and testing

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r services/api/requirements.txt
npm --prefix apps/web ci
make check
npm --prefix apps/web run test:e2e
```

Install Playwright's browser dependencies when needed:

```sh
cd apps/web
npx playwright install --with-deps chromium
```

Development servers: `make api-dev` and `make web-dev`. Read the frontend agent instructions and bundled Next.js docs before changing framework code.

GitHub Actions checks API/migrations and frontend lint, types, build and smoke rendering. Run relevant browser tests separately; these are not substitutes for live integration acceptance. Do not attach real meeting transcripts or credentials to public test artifacts.

## Contributing and support

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Use GitHub issues for reproducible bugs and feature proposals, and [SECURITY.md](SECURITY.md) for private vulnerability reporting. There is no guaranteed support SLA.

## License and acknowledgments

Original Meetings AI code and documentation are licensed under [Apache License 2.0](LICENSE), unless a file states otherwise. Copyright © 2026 GenAI Protos and Meetings AI contributors.

Meeting capture builds on **Vexa**, maintained by Vexa contributors. The fork is pinned at `1a8084e9a7f57a79902ed9bad9ae3b5c11c01e10`; it adds signed per-bot STT routing and associated capability/test changes. Upstream licenses and notices remain intact.

See [NOTICE](NOTICE) and [third-party attribution](THIRD_PARTY_NOTICES.md). Dependencies, model weights, container contents and hosted services retain their own licenses or terms. Apache 2.0 does not grant rights to third-party trademarks, and Meetings AI is not affiliated with or endorsed by the named service providers.
