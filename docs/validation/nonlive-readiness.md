# Non-live readiness — updated 2026-09-25

Live meeting joins, speaker-quality measurement, and real email delivery are
deferred by the owner. They remain **unvalidated**. Do not treat automated tests
or healthy containers as proof of those outcomes.

## Implemented and checked without joining a meeting

- The product API, web app, PostgreSQL, and Vexa Lite run locally.
- Provider selection is passed as a signed per-bot STT route; the Vexa fork
  advertises and attests that capability. Both sides have unit/API tests.
- The meeting screen shows a credential-free record of the selected STT route.
- Transcript review, evidence-linked MOM edits, approval, retries, and Resend
  delivery controls have API and mocked-browser tests. No real email is sent
  by these tests.
- Schema steps 3–14 preserve prior rows; startup refuses missing, unknown, or
  future schema states. Compose health checks use `/ready`, which queries the
  database and its current schema version.
- A vector logo, meeting tags, opt-in AI knowledge settings, source-linked
  lexical/hybrid search, and provider-agnostic draft Q&A are implemented and covered
  by non-live tests. Search reads finalized transcript turns and approved/sent
  MOM facts, not live provisional text. Source links include meeting date,
  speaker label, transcript offset, and exact segment ID. These functions
  have not been evaluated for recall or answer quality on real meetings.
- Named knowledge bases, per-base text-model selection, saved chats, local
  email/password accounts, forced temporary-password change, route-level member
  restrictions, and private/organization/specific sharing have API coverage.
  Browser and live multi-user acceptance are still pending. There is still
  local workspace creation and application-level two-organization isolation are
  covered; hosted database RLS is not built.
- Production startup refuses development encryption keys, SQLite, insecure web
  origins, weak admin/session secrets, and missing Vexa/STT secrets. This guard
  does not imply that a production deployment is ready.

## Still unvalidated

- Bot admission and completed capture on Google Meet, Zoom, and Teams with the
  new per-bot STT route.
- Measured speaker attribution on 3+ speakers, overlap, and multiple languages.
- Automatic post-meeting drafting on a real completed meeting and actual Resend
  delivery, including sender-domain acceptance and participant opt-in.
- Production multi-replica operation, backups/restores, and tenant isolation.
- Live semantic retrieval quality, query-planning agents, linked topic/person
  pages, background indexing, and saved-chat retention/deletion. Manual
  organization-scoped indexing and mutation-triggered vector purge are built.
- Hosted database isolation/RLS, external identity/SSO, account recovery,
  distributed rate limiting, production audit retention, and billing.

Follow [capture acceptance](mvp-acceptance.md) only when live testing resumes.
Rotate all API keys previously pasted into chat before that witness.

## Source and database handoff

Vexa's Meetings AI change is published on the `meetings-ai-integration` branch
of the public [Meetings AI Vexa fork](https://github.com/AbhishekSharma-17/vexa)
at `1a8084e9a7f57a79902ed9bad9ae3b5c11c01e10`. The parent project pins
that commit as a submodule. A remote checkout must initialize submodules.

Back up the database before applying a future migration. Migrations are
additive and forward-only at present; there is no automated rollback. The
version manifest in `services/api/app/database.py` is frozen to the model
columns: a new table or column requires a new numbered migration, not a silent
`create_all` at application startup.
