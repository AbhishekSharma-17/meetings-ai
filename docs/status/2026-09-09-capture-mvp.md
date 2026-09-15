# Local capture MVP verification

Last updated: 2026-09-15

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
- Durable structured MOM drafts with executive summary, discussion points,
  decisions, action items, owners, due dates, and open questions.
- Human editing and explicit approval before any recap delivery.
- Resend delivery with manual recipients, optional transcript inclusion, persisted
  delivery outcome, and locking of the sent MOM version.

## Verified locally

- API unit/integration suite: 26 tests passed, including MOM generation, approval,
  email gating, provider HTTP contracts, and the live PostgreSQL witness.
- PostgreSQL repository witness: passed against the Compose PostgreSQL service.
- Persistence: the local Vexa transcription profile and its default selection
  survived an API container restart.
- Web: TypeScript, lint and production build passed.
- Browser walkthrough: four Playwright scenarios passed for same-origin routing,
  create/join lifecycle, durable join-failure recovery, and the complete MOM
  review/approve/send workflow. Provider and Vexa mutations are mocked and isolated.
- Vexa preflight: the running local gateway accepted the configured key with
  `bot`, `tx` and `browser` scopes and reported a concurrency limit of three.
- Live Google Meet witness: the product dispatched the bot, the host admitted it,
  and attributed transcript segments appeared in the Meetings AI UI.
- Real OpenAI MOM witness: a synthetic transcript produced a schema-validated draft
  through the configured economy text model. The synthetic database rows were removed.

## Not yet claimed

- Zoom and Teams still require live platform witnesses.
- Resend's request path is implemented and mocked end-to-end; live delivery from
  `genaiprotos.com` remains blocked until the sending domain is verified.
- Automatic recipient discovery, organization policy, authentication, background
  jobs, knowledge compilation, search, and chat over meetings remain later slices.
- The current schema bootstrap is suitable for the local MVP; production will
  move to versioned Alembic migrations and durable workflow workers.

## Local surfaces

- Product web: `http://localhost:3020`
- Product API: `http://localhost:8320`
- API documentation: `http://localhost:8320/docs`
- Vexa Terminal: `http://localhost:3001`
