# Meetings AI API

The local capture MVP stores provider profiles, meeting lifecycle state and
transcript snapshots in PostgreSQL. Public schemas never expose credentials.

From the repository root:

```bash
PYTHONPATH=packages/contracts:services/api \
  uvicorn app.main:app --reload
```

OpenAPI is available at `http://127.0.0.1:8000/docs` and health at `/health`.

Configuration:

- `DATABASE_URL` — SQLAlchemy URL; Compose uses PostgreSQL via `postgres:5432`.
- `VEXA_BASE_URL` — Vexa gateway base URL.
- `VEXA_API_KEY` — Vexa gateway API key (`VEXA_ADMIN_TOKEN` is a deprecated fallback).
- `PROVIDER_CREDENTIAL_KEY` — server-side key used to encrypt provider credentials.

The built-in `development-only-change-me` credential key is only a local bootstrap
default. Set a stable, private value before retaining any real provider credential.
Changing it makes previously encrypted credentials unreadable.

The API creates/updates the current schema synchronously while the application is
constructed. A database connection or migration failure aborts startup instead of
allowing a process with a misleading healthy status.

Meeting API shapes used by the web client:

- `POST /v1/meetings` and lifecycle actions return one complete meeting object.
- `GET /v1/meetings` returns `{ "items": [...], "count": 1 }`.
- `GET /v1/meetings/{id}` refreshes non-terminal upstream state when Vexa is
  reachable and falls back to its last durable state when it is not.
- `GET /v1/integrations/vexa/health` verifies Vexa reachability and the required
  `bot` and `tx` API-key scopes without launching a bot.
- `GET /v1/meetings/{id}/transcript` returns `{ "meeting_id", "status",
  "segments", "segment_count" }`; segment timing fields are `start_seconds` and
  `end_seconds`, and finalized state is `completed`.

Transcript snapshots are persisted in PostgreSQL after successful Vexa reads and
are returned during a temporary Vexa outage.
