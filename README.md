# Meetings AI

Meetings AI is a provider-agnostic meeting agent built around a pinned Vexa capture subsystem. The product will join Google Meet, Zoom and Microsoft Teams, produce a versioned transcript and evidence-backed MOM, deliver approved recaps, and compile governed organizational knowledge.

## Current implementation slice

The current local capture slice establishes:

- the product web application and manual meeting journey;
- a FastAPI product API with PostgreSQL persistence;
- product meeting creation, Vexa bot dispatch, lifecycle refresh and idempotent stop;
- exact-meeting transcript reads with a durable cached fallback;
- stable segment IDs, upstream speaker provenance, and persistent per-turn speaker corrections;
- separate invitee and heard-speaker views, with explicit speaker-to-email confirmation;
- automatic post-meeting MOM drafting through the selected text-generation provider;
- evidence-linked speaker contributions, questions asked, and action items in the MOM;
- persisted human review, explicit approval, and sent-version locking;
- per-meeting internal recipients, optional participant opt-in, and recap delivery through Resend;
- local owner and teammate email/password accounts, admin-generated one-time
  temporary passwords, first-login rotation, workspace creation/switching,
  self-service display names and passwords, role changes, immediate workspace
  removal, and knowledge-specific access;
- application-level organization isolation for meetings, providers, knowledge,
  workspace settings, and background MOM processing; hosted database RLS and
  production identity lifecycle are not yet complete;
- named knowledge bases with confirmed deletion, per-base AI model choice,
  source-linked saved chats with per-user JSON export and deletion,
  and private/organization/specific-teammate sharing;
- an evidence map of literal topics and speaker labels linked to exact transcript
  turns, distinguishing confirmed email identities from unverified labels;
- provider profiles for transcription, text generation and embeddings;
- meeting tags and opt-in AI knowledge with source-linked hybrid search and
  draft Q&A through the configured text-generation provider;
- Vexa-native, OpenAI and OpenAI-compatible provider boundaries;
- write-only credential handling and capability validation;
- a pinned local Vexa `v0.12.27` checkout for the ARM64 Lite witness path.
- terminal-meeting deletion that requests Vexa artifact erasure before removing
  the product transcript, MOM, indexed copies, and chats citing the meeting;
- independent deletion of an unsent MOM draft or approval while retaining its
  transcript; sent recaps require deleting the full meeting record;
- durable, retryable background knowledge indexing, linked wiki meetings by
  explicit tags or confirmed speakers, and bounded query planning for complex
  Ask AI questions;
- workspace-scoped operations counts and opt-in retention policies for old
  meetings, saved chats, and audit events (off by default).
- per-user, read-only Google Calendar and Outlook Calendar connections through
  Composio; review supported meeting links from today, tomorrow, this week,
  or next week before creating a capture;
- scheduled assistant joins for selected future calendar events, with durable
  status and cancellation. The local scheduler runs in one API process; it
  does not auto-send a recap or enroll everyone on a calendar invitation.
- persisted per-user calendar snapshots across multiple Google, Outlook,
  Calendly, and Zoom accounts, with a month view, source labels, custom 1–90
  day syncs, attendee details, and manual resync;
- an organization briefing profile and PDF, DOCX, Markdown, or text documents
  as private meeting-prep context, combined with optionally cited public
  research and a configurable synthesis provider.

The Vexa capture and OpenAI MOM paths are active locally. Resend delivery is wired
to the approved-MOM workflow. The API exposes `GET /v1/integrations/resend/status`
and the MOM screen shows whether an API key and sender are configured. A configured
sender does **not** prove domain verification: Resend must accept a real send.
The app no longer silently falls back to `onboarding@resend.dev`; set
`RESEND_FROM_EMAIL` explicitly. Approved-MOM sends carry a deterministic
idempotency key to avoid duplicate provider sends during retries. The recap uses
an HTML and plain-text template; the logo is an inline image. When the sender
chooses to include the transcript, it is attached as a timestamped Markdown
file rather than appended to the message body. Internal segment IDs are kept
out of the recipient-facing recap.

For a local email witness, configure a Resend key from the account that owns the
sending domain, set `RESEND_FROM_EMAIL`, restart the API, then review and approve
a MOM and send it to an address you control. A send-only Resend key cannot manage
or inspect domains. The current local sender is `meetings@genaiprotos.com`, and
the API uses a domain-scoped send-only key in the ignored `.env.local` file. On
2026-09-23, the product sent an approved MOM to `abhishek@genaiprotos.com`;
Resend reported it delivered. The domain still has a failed click-tracking CNAME
record, which should be fixed before relying on click tracking. The `meetings@`
address is a sender on the verified root domain, not a separate mailbox; Resend
receiving is disabled for this domain, so replies need a separately configured
inbox or reply-to route.
All provider credentials belong in the ignored local secret file and must be rotated
if they have appeared in a chat or task transcript.

See the [local capture verification record](docs/status/2026-09-09-capture-mvp.md)
for the exact checks already passed and the next incomplete slices.
The [build roadmap](docs/roadmap.md) tracks the remaining live validation,
runtime integration, UI/UX work, and later SaaS features.

## Provider model

Provider selection is exposed in the product. Text generation uses the selected
provider for MOM drafts and knowledge answers. A selected transcription profile
is signed into the next Vexa bot run; existing bots retain their prior route.
Embeddings are configurable, and the OpenAI/OpenAI-compatible batch runtime can
build a manually refreshed index for each named knowledge base. Without an index,
search remains lexical. Indexed results are checked against current meeting
records before use; this is not yet a background or large-scale vector service.

- Transcription, text generation and embeddings have separate provider profiles.
- Profiles declare capabilities such as streaming, timestamps, diarization, structured output and tool calling.
- MOM drafts record the text-generation profile and model that produced them.
- Credentials are resolved only on the server and are never returned by the settings API.
- Text-generation fallback follows an explicit selected policy. A local route
  does not silently forward meeting content to a cloud provider.

See [ADR 0001](docs/adr/0001-provider-agnostic-ai.md).

## Local prerequisites

- Docker 28+
- Node.js 22+
- Python 3.12+
- A host capable of reaching the selected meeting and AI providers

This development host is ARM64. The standard Vexa bot image is AMD64-only; the initial witness uses Vexa Lite, which supports ARM64 and is best limited to one browser bot at a time.
For local development, `make vexa-up` uses the local
`Systran/faster-whisper-small.en` CPU model by default. Set
`VEXA_STT_MODE=remote` in the ignored `.env.local` file to instead use the
`TRANSCRIPTION_SERVICE_URL`, `_TOKEN`, and `TRANSCRIPTION_MODEL` values in the
ignored `vendor/vexa/.env` file. The current local remote route is OpenRouter's
`microsoft/mai-transcribe-2`; it was checked with a short synthetic audio clip,
not a live multi-speaker meeting. The previous local Whisper containers remain
available for rollback. The matching OpenRouter transcription profile is saved
as the product default. Changing that default now routes the next bot through
the selected profile; existing bots keep their current route. STT text accuracy
does not guarantee correct speaker attribution; use the human-reviewed transcript
and the multi-speaker evaluation.

The custom local Vexa fork now accepts a signed, five-minute per-bot STT route.
When a transcription profile is selected, Meetings AI sends its endpoint,
model, and server-side credential together for the next bot only; Vexa must
advertise this capability and attest the selected profile in its join response.
Existing bots keep their invocation route. Set one random
`VEXA_STT_OVERRIDE_SECRET` in the ignored `.env.local`; `make vexa-up` passes it
to Vexa Lite and Compose passes it to the product API. Without it, a selected
profile blocks joining rather than silently falling back. No selected profile
still uses Vexa's deployment STT default. This route has automated coverage,
but needs a real meeting witness. See [capture acceptance](docs/validation/mvp-acceptance.md).

## Secrets

Copy `.env.example` to `.env.local` and insert newly rotated credentials there. Do not paste credentials into source files, commits, issues or task transcripts. See [the secrets runbook](docs/security/secrets.md).
`make compose-up` automatically loads `.env.local` when it exists.
The local Compose stack enables the post-meeting draft worker and owner login.
Set `MEETINGS_AI_ADMIN_EMAIL`, `MEETINGS_AI_ADMIN_PASSWORD`, and a distinct
`MEETINGS_AI_SESSION_SECRET` in `.env.local`. The admin password seeds the
PostgreSQL owner account only if it has no credential; changing the password
in the UI does not make an older `.env.local` value valid again. On this host
the existing password is in the ignored `.env.local`; do not paste it into
chat. Open `http://localhost:3020` and sign in with the admin email and that
password. In Workspace, an admin can add teammates. When Resend is configured,
an invitation email contains a one-time temporary password and sign-in link;
otherwise the password is shown to the admin once for private sharing. New
users must change it before accessing the app.
After a meeting finishes, a background
poller finalizes the transcript and drafts the MOM. It never sends an email
automatically: review, approve, and click **Send recap** to deliver. The worker
only auto-processes meetings created after this feature was enabled; older records
retain manual MOM generation. It is currently single-process;
multi-replica deployment requires a queued worker.
If automatic drafting fails, the meeting screen shows the error and offers an
immediate retry after capture completes. A sent recap is locked; a future
versioned correction workflow is required to change it without losing the
record of what recipients received.

Speaker attribution is best-effort from Vexa, not guaranteed identity recognition.
An unknown or technical speaker label stays **Unidentified speaker** until reviewed.
The UI shows the capture label, lets an admin correct one turn or all turns with
the same label, and keeps those corrections when the transcript refreshes. Named
MOM claims cite exact transcript segments; changing the transcript or a speaker
invalidates approval until the MOM is regenerated. Invitee emails are never
automatically matched to voices or added to recap recipients. A confirmed
speaker-email mapping is separate from the explicit recap delivery setting.
For a multi-speaker acceptance test, label the actual speaker for each segment
in a JSON file and run `python3 scripts/speaker_eval.py transcript.json reference.json`.
Use **Download transcript JSON** in the meeting view, then create a reference
file such as `{"segment-id-1":"Alice","segment-id-2":"Bob"}` from a human
review of the audio. Keep both files private: they contain meeting content and
identity information.
The report measures turn-level speaker attribution—not audio diarization error
rate—and should be reviewed alongside the audio and MOM evidence links.

Database startup applies additive schema steps 3 → 21 and preserves existing
rows. It refuses an unversioned, future, or incomplete schema instead of
silently stamping it current. `/health` is process liveness; `/ready` verifies
the database and current schema and is used by Compose. Back up PostgreSQL
before any future schema upgrade. In `APP_ENV=production`, startup also rejects
development credentials, SQLite, an HTTP web origin, and missing Vexa/STT
secrets; see [non-live readiness](docs/validation/nonlive-readiness.md).
The **Workspace** screen stores the current organization's profile and shows
members, roles, and account status. Admins can create or reset temporary
passwords. Members can see only shared knowledge bases and completed cited
transcripts; provider and meeting management remain admin-only. API records are
scoped to the signed-in organization, with a two-organization denial test.
Self-serve organization creation, switching, hosted RLS, and public signup are
not built; see the [SaaS build sequence](docs/saas/roadmap.md).

The **AI knowledge** screen supports named client/project knowledge bases,
meeting assignment, tags, and explicit opt-in. Search reads finalized
transcript turns and approved/sent MOM facts; Ask AI drafts source-linked
answers through either a per-base text profile or the workspace default.
Chats inside a named base are saved per user. A creator or admin can keep a
base private, share it with this organization, or choose specific teammates.
The meeting page can edit tags, assignment, and opt-in. A base creator or admin
can manually reindex for hybrid lexical/semantic search; changes to canonical
records purge that meeting's stored vectors until reindexed. The evidence map
links literal tags and speaker labels to timestamped turns. A model-inferred
topic graph, planning agent, background indexing, saved-chat retention policy,
and measured retrieval quality remain to build. See the
[knowledge flow and limits](docs/knowledge/architecture.md).
Do not expose this as a public multi-customer SaaS before hosted database
policies, account lifecycle, and security hardening are complete.

## Calendar discovery

Set `COMPOSIO_API_KEY`, `COMPOSIO_GOOGLE_CALENDAR_AUTH_CONFIG_ID`, and
`COMPOSIO_OUTLOOK_AUTH_CONFIG_ID` in the ignored `.env.local`; Compose passes
them only to the API. Auth configurations should request calendar read-only
scopes and restrict tools to event listing. Set `APP_BASE_URL` to the deployed
HTTPS app origin in production. In local development the connect action uses
the browser-visible `localhost` port, including a forwarded port on another
device, instead of assuming the DGX's `localhost:3020` is reachable from that
browser. Run `make compose-up`, sign in, and open **Calendar**. Its
**Integrations** tab shows connected accounts; the calendar displays the last
saved snapshot and supports manual sync for a custom range of up to 90 days.
Multiple accounts can be synced together, and overlapping events retain
separate source labels. Each user connects their own account and explicitly
chooses an event. Discovery skips cancelled and unsupported-link events.
Outlook Calendar supplies Teams join links in event data; a separate Teams
connection is not needed for those calendar events. Zoom scans currently
return upcoming hosted meetings only, not historical ones. Future events
create a scheduled record; the single-process worker joins about one minute
before the start, unless the join is cancelled. It marks meetings missed
instead of joining after a long outage. Meetings starting immediately use the
existing manual join flow. Live provider consent and event scans still need
validation with real connected accounts.

In **Organization & people**, admins can save company overview, services,
products, positioning, website, and documents. The sidebar's dedicated
**Meeting prep** section lists upcoming synced events; Calendar's **Prepare
for meeting** action opens the same workspace with an event selected. It adds
target-company hints, public profile links, and a manual objective. With
public research enabled, a configured OpenAI text profile uses the Responses
web-search tool; final synthesis may use any configured text provider. Private
company documents are sent only to the synthesis provider, never to web
search. Saved briefings link public claims to source URLs. Scanned PDFs need
OCR before upload. Meeting retention also removes old calendar snapshots and
their prep reports; company documents require manual deletion. Web-search
tool charges are not included in token-only cost estimates.

The calendar integration has no mailbox access, Gmail inbox scanning, or
automatic attendee-email delivery. The selected calendar event is re-read by
the server before scheduling, so the browser cannot substitute its own link.

## Source layout

```text
apps/web/                 Next.js product UI
services/api/             FastAPI product API
services/api/app/post_meeting_worker.py  single-process draft reconciler
services/worker/          queued workflows (production slice)
services/stt-bridge/      provider-normalized audio boundary (next slice)
packages/contracts/       application-owned provider and meeting schemas
packages/email-templates/ reusable branded templates (later slice)
integrations/             Vexa, provider and email adapters
vendor/vexa/              pinned public Meetings AI fork/submodule
```

## Vexa pin

- Tag: `v0.12.27`
- Upstream base commit: `cbaf88c6530d5e41368fc2df80e33c53240bd49e`
- Local Meetings AI fork commit: `1a8084e9a7f57a79902ed9bad9ae3b5c11c01e10`
- Upstream: <https://github.com/Vexa-ai/vexa>

Meetings AI fork: <https://github.com/AbhishekSharma-17/vexa>. The custom
revision is published on the `meetings-ai-integration` branch and the product
submodule points to that exact commit. Clone this repository with submodules.
