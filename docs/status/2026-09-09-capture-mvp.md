# Local capture MVP verification

Date: 2026-09-09

## Delivered

- Next.js product UI for creating a meeting record and opening its lifecycle view.
- FastAPI product API with PostgreSQL persistence for provider profiles, defaults,
  meetings and transcript snapshots.
- Vexa gateway adapter for API-key preflight, bot launch, exact meeting refresh,
  idempotent product-level stop and transcript retrieval by persisted Vexa ID.
- Frontend polling for joining, lobby, live, needs-attention, stopping and terminal
  states, with transcript timestamps and speaker labels when Vexa supplies them.
- Provider-agnostic settings for Vexa-native, OpenAI and OpenAI-compatible routes.
  Credentials are encrypted at rest and remain write-only through the public API.

## Verified locally

- API unit/integration suite: 22 tests passed, including the live PostgreSQL witness.
- PostgreSQL repository witness: passed against the Compose PostgreSQL service.
- Persistence: the local Vexa transcription profile and its default selection
  survived an API container restart.
- Web: TypeScript, lint and production build passed.
- Browser walkthrough: two Playwright scenarios passed for create/join lifecycle
  and durable join-failure recovery, with Vexa network calls safely mocked so no
  external bot was launched.
- Vexa preflight: the running local gateway accepted the configured key with
  `bot`, `tx` and `browser` scopes and reported a concurrency limit of three.

## Not yet claimed

- A live Google Meet, Zoom or Teams witness still requires a real meeting URL and
  a host available to admit the assistant.
- MOM/action extraction, approval, Resend delivery and organizational knowledge
  compilation are later slices and are not represented as complete in the UI.
- The current schema bootstrap is suitable for the local MVP; production will
  move to versioned Alembic migrations and durable workflow workers.

## Local surfaces

- Product web: `http://localhost:3020`
- Product API: `http://localhost:8320`
- API documentation: `http://localhost:8320/docs`
- Vexa Terminal: `http://localhost:3001`
