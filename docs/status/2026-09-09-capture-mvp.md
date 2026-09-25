# Local capture MVP verification

Last updated: 2026-09-23

## Delivered

- Next.js product UI for creating a meeting record and opening its lifecycle view.
- FastAPI product API with PostgreSQL persistence for provider profiles, defaults,
  meetings and transcript snapshots.
- Vexa gateway adapter for API-key preflight, bot launch, exact meeting refresh,
  idempotent product-level stop and transcript retrieval by persisted Vexa ID.
- Frontend polling for joining, lobby, live, needs-attention, stopping and terminal
  states, with transcript timestamps and speaker labels when Vexa supplies them.
- Stable Vexa segment IDs and raw speaker labels retained beside resolved labels.
  Technical or unbound labels remain unidentified; an admin can correct a turn
  or explicitly apply a correction to turns with the same raw label. Corrections
  survive Vexa refreshes.
- Invitees and heard speakers are shown as separate evidence sources. A speaker
  email can be linked only by an explicit admin confirmation, and linking it
  does not opt that address into recap delivery.
- Provider-agnostic settings for Vexa-native, OpenAI and OpenAI-compatible routes.
  Credentials are encrypted at rest and remain write-only through the public API.
- Durable structured MOM drafts with executive summary, discussion points,
  decisions, action items, owners, due dates, and open questions.
- Evidence-linked speaker contributions, attributed questions, and action items.
  Generated claims with missing or mismatched speaker/segment evidence are
  rejected. Transcript changes invalidate MOM approval until regeneration.
- Human editing and explicit approval before any recap delivery.
- Resend delivery with manual recipients, optional transcript inclusion, persisted
  delivery outcome, and locking of the sent MOM version.
- Saved per-meeting internal and participant recipient choices. Participant sharing
  is off by default and requires explicit opt-in. Delivery still requires an
  approved MOM and a manual send action.
- Single-admin password login with an HttpOnly signed session cookie for local
  internal validation. This is not multi-tenant organization authentication.
- A single-process background reconciler polls active Vexa meetings, fetches
  the final transcript, and generates a draft automatically after completion.
  It only picks up newly created meetings, preserves existing drafts, and stops
  after five persisted, backoff-spaced
  failures; the UI surfaces those failures and retains manual generation.

## Verified locally

- API unit/integration suite: 34 tests passed, including MOM generation, approval,
  email gating, provider HTTP contracts, and the live PostgreSQL witness.
- A three-speaker fixture verifies unresolved labels, correction persistence,
  separate invitees, MOM speaker evidence, and stale-approval blocking. A
  turn-level attribution evaluation script is available for a later live test.
- PostgreSQL repository witness: passed against the Compose PostgreSQL service.
- Persistence: the local Vexa transcription profile and its default selection
  survived an API container restart.
- Web: TypeScript, lint and production build passed.
- Browser walkthrough: four Playwright scenarios passed for same-origin routing,
  create/join lifecycle, durable join-failure recovery, and the complete MOM
  review/approve/send workflow. Provider, Vexa, and email mutations are mocked
  and isolated. Admin login was additionally checked through both the direct API
  and the same-origin web proxy.
- Vexa preflight: the running local gateway accepted the configured key with
  `bot`, `tx` and `browser` scopes and reported a concurrency limit of three.
- The local Vexa participants endpoint responded for an existing capture with
  speaker-source rows and `observed_roster: not_recorded`; it did not establish
  complete attendance or an invitee-to-speaker identity match.
- Live Google Meet witness: the product dispatched the bot, the host admitted it,
  and attributed transcript segments appeared in the Meetings AI UI.
- Local STT quality preset: Vexa Lite can route to
  `Systran/faster-whisper-small.en` on the CPU sidecar. A synthesized-speech
  transcription smoke test passed, and the product's Vexa key still passed
  gateway preflight after the switch. This is **not** a multi-speaker accuracy
  witness; the previous tiny model sidecar remains idle as a rollback option.
- OpenRouter STT trial: the local Vexa Lite deployment now selects
  `microsoft/mai-transcribe-2` through its configured remote transcription URL.
  An eight-second synthetic clip returned correct text plus segment and word
  timestamps using Vexa's multipart request shape. The provider catalog accepted
  the new key, Vexa restarted healthy with the remote URL and model, and all
  product/API health checks passed. The matching product transcription profile
  is now selected as the default, and the older OpenRouter MOM profile's key was
  refreshed. This is an API-contract witness, not a live meeting or a validated
  speaker-diarization result. The product provider picker still does not change
  Vexa's running STT route automatically.
- Real OpenAI MOM witness: a synthetic transcript produced a schema-validated draft
  through the configured economy text model. The synthetic database rows were removed.
- New multi-speaker OpenAI witness: a three-speaker synthetic transcript produced
  a draft with three speaker contributions, one attributed question, and two
  evidence-cited actions through the configured economy model. This ran in an
  ephemeral in-memory database; it did not join a meeting or send email.
- Live Resend witness: an approved MOM was sent through the product API to
  `abhishek@genaiprotos.com` with a domain-scoped send-only key. The API saved
  the delivery ID and locked the MOM; Resend reported the email delivered.
  A second send request was rejected with HTTP 409, preventing a duplicate.

## Not yet claimed

- Zoom and Teams still require live platform witnesses.
- Live multi-speaker quality has **not** yet been measured. The existing local
  Vexa witness transcript had one distinct named speaker; mocked fixtures prove
  workflow correctness, not real-world diarization accuracy. Silent attendees
  cannot be inferred from the capture transcript, and invitation records are
  not proof of attendance.
- Resend reports a failed click-tracking CNAME for `link.genaiprotos.com`, even
  though the sending records and live delivery work. Click tracking remains
  unverified until that record is corrected or tracking is disabled.
- Automatic participant email discovery, organization policy, multi-user access,
  queued/multi-replica background jobs, knowledge compilation, search, and chat
  over meetings remain later slices.
- The automatic draft worker was validated with a mocked Vexa completion and
  mocked model; no fresh live end-to-end meeting was run in this build pass.
- The current schema bootstrap is suitable for the local MVP; production will
  move to versioned Alembic migrations and durable workflow workers.

## Local surfaces

- Product web: `http://localhost:3020`
- Product API: `http://localhost:8320`
- API documentation: `http://localhost:8320/docs`
- Vexa Terminal: `http://localhost:3001`
