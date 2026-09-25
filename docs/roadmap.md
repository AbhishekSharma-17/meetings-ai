# Meetings AI — build roadmap

Updated 2026-09-24. This is an implementation sequence, not a claim that the
untested integrations already work in production. Live platform testing is
deferred at the owner's request.

## Current baseline

The local application can create and dispatch a Vexa bot, persist meeting state and
transcript segments, correct speaker labels, produce an evidence-linked MOM
draft, require review/approval, and manually send the approved recap through
Resend. The local owner and invited teammates use email/password accounts;
members are restricted to knowledge bases shared with them. PostgreSQL stores product data.
Automated API and mocked-browser coverage exists; a previous live Google Meet
capture and a separate delivered email are the live witnesses so far.
The owner has deferred additional live testing. The non-live hardening slice is
implemented: schema steps 3–13, database-backed readiness, production startup
configuration checks, API CI, and a local-only Vexa fork commit. See
`docs/validation/nonlive-readiness.md` for the explicitly unvalidated outcomes.

## Now — validate the core meeting workflow

1. **Runtime transcription-provider selection.** Connect the selected product
   transcription profile to Vexa's per-user or platform transcription settings
   before bot launch. Avoid changing a global running route for other meetings;
   prove URL, model, and credential ownership are kept together, no key is
   exposed through the browser, and switching profile really changes a new
   bot's invocation. A signed per-bot route and Vexa capability/response
   attestation are implemented in the local fork and tested with fake runtime
   ports. Real Google Meet, Zoom, and Teams join witnesses remain outstanding.
2. **Speaker quality.** Consume actual speaker evidence from the configured STT
   path, retain stable diarization labels, and keep uncertain turns unidentified.
   Measure turn-level attribution on multilingual, overlapping, and 3+ speaker
   recordings. The evaluation harness reports those cohorts and can fail a
   release threshold; the representative human-labeled recordings still need
   to be collected. Human corrections and confirmed contact mapping remain required
   before person-specific MOM or email claims.
3. **Post-meeting reliability.** Run the completion → final transcript → draft
   path against a real meeting. Validate retries, idempotency, stale-draft
   invalidation, and failure recovery. The local worker now exposes an immediate
   retry for failed drafts, reconciles manually-created drafts, and rejects
   regeneration of an already-sent recap. These are automated-test witnesses,
   not a substitute for a real post-meeting acceptance run. Email remains
   approval-gated in the current product.
4. **End-to-end acceptance.** Witness Google Meet, Zoom, and Teams separately;
   lobby/admission, audio, speaker labels, completion, MOM, recipients, and
   Resend delivery. Follow `docs/validation/mvp-acceptance.md`. Check
   sending-domain DNS and rotate exposed keys first.

## Parallel product-quality task — UI/UX redesign

Build one consistent, responsive product interface across sign-in, meeting
overview, capture setup, lifecycle, transcript review, MOM approval/delivery,
and provider settings. Design criteria: clear hierarchy, legible states, usable
small-screen layouts, keyboard/focus support, explicit error/retry paths, no
misleading buttons, and honest distinctions between configured profiles and
active runtime routes. The first visual/system pass is in the product UI; it
still needs browser/a11y review with real content and user feedback.

## Production-scale product work

The owner has asked to start SaaS work while live testing remains deferred.
Organization-scoped API access, local accounts, workspace creation/switching,
invitations, named knowledge bases, and scoped sharing are built in code.
Hosted RLS, complete organization lifecycle, and production identity are still
needed. See [SaaS build sequence](saas/roadmap.md).

1. **Agentic knowledge base:** durable background indexing, bounded query
   planning, linked meetings by explicit evidence, and opt-in retention are
   built locally. Full topic/person pages, a measured retrieval evaluation,
   and multi-worker index execution remain. Preserve provider-agnostic text
   and embedding adapters.
2. **Operational scale:** workspace operations counts and versioned migrations
   are built. A multi-replica workflow queue, alerts, S3-compatible storage
   where necessary, deployment hardening,
   cost and rate controls, and backup/restore.
3. **SaaS layer:** hosted RLS, organization lifecycle, multiple roles, policy controls,
   invitations, audit trail, calendar scheduling, billing, and self-serve setup.

## Release gate

Do not call the product a complete production SaaS until real cross-platform
captures, diarization accuracy, delivery, security, tenant isolation, recovery,
and deployment operations have all been demonstrated. Automated tests alone
do not satisfy the live-capture gate.
