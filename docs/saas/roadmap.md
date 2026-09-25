# Meetings AI SaaS build sequence

This separates a real multi-tenant product from the current internal pilot.
Live capture, speaker quality, and email delivery remain **unvalidated** while
testing is deferred. Billing or signup must not be enabled before isolation.

| Stage | User-visible capability | Required backend boundary | Status |
| --- | --- | --- | --- |
| 0. Internal pilot | One admin, meetings, providers, reviewed MOM, manual delivery | One shared database workspace | Built; live outcomes unvalidated |
| 1. Workspace foundation | Edit organization profile, see people and roles | Organization, user, membership and credential records | Built locally; **one organization only** |
| 2. Tenant isolation | Multiple private workspaces | Organization IDs on every meeting, transcript, MOM, delivery, provider profile/default, job, and knowledge item; scoped queries and workers; cross-tenant denial tests | Next build slice |
| 3. Accounts and roles | Email/password login, admin-generated temporary passwords, first-login rotation and owner/admin/member/viewer boundaries | Local account sessions built; external OIDC, workspace switching, audit events, rate limits and lifecycle controls remain | Partial local pilot |
| 4. Team operations | Calendar scheduling, shared templates, delivery policies, retention controls | Durable queue, policy enforcement, deletion/export, observability and backups | Planned |
| 5. Agentic knowledge | Named bases, meeting assignment, private/org/specific sharing, saved chats, selectable text model, source-linked Q&A | Current pilot retrieves directly from canonical records; organization-scoped semantic indexing, re-index/delete, query planning and linked topic pages remain | Expanded lexical pilot built; semantic agent planned |
| 6. Commercial SaaS | Plans, usage visibility, billing, self-serve setup | Metered usage, quotas, payment webhooks, dunning, tax/invoicing choices | Planned; no gateway selected |

## Isolation rule for the next slice

The current API holds one singleton repository and one local organization.
Accounts can join only that organization; no account may select or create
another organization yet. First, migrate the
existing records into the legacy organization. Then require an organization
context on all repository reads and writes, including background jobs and
provider defaults. Return 404 for another organization's resource ID so its
existence is not disclosed. Verify two-organization fixtures cannot read,
modify, send, export, or search each other's data. Only after these tests pass
should signup, invitations, or switching become visible in the UI.

The workspace contact email is metadata only. It does not alter the Resend
sender or recipients. Local account roles now gate admin routes and knowledge
sharing within this one organization; that is not a substitute for complete
tenant-scoped repository queries or a production identity service.

Do not open the AI knowledge screen to multiple customer organizations until
stage 2 isolates every search and chat source by authenticated organization,
including provider configuration and background workers.

## Provider and assistant-branding slice

The local provider UI supports multiple named configurations for transcription,
MOM/Ask AI text generation, and embeddings. OpenRouter is a first-class UI
preset backed by the OpenAI-compatible adapter; custom endpoints and local
models remain available. Keys are encrypted at rest and never returned by the
API. A configuration can be deleted; its credential, defaults, and knowledge
base model reference are cleared, while historical MOM and capture snapshots
remain. Validation checks saved fields, **not** live provider connectivity.

The application icon is a scalable SVG, with a 1024-pixel assistant avatar at
`apps/web/public/brand/meetings-ai-avatar-1024.png`. The current pinned Vexa
gateway does not expose a working avatar endpoint or join-time avatar setting
(its health advertises signed STT override only). The asset is therefore
**not yet displayed inside Google Meet, Zoom, or Teams**. Before enabling this
claim, implement and test a Vexa camera/avatar path for each platform, then
host the image at a reachable HTTPS URL and verify a live join. Do not send
an undocumented avatar field to the current `/bots` endpoint, where it would
silently fail or break joining.

## Decisions needed before stages 3 and 6

- Identity provider and sign-in methods (OIDC/SSO, passwordless, or both).
- Billing provider, billing currency/region, unit of usage, and free-trial
  policy. These choices affect customer-facing behavior and should not be
  guessed from the internal pilot.
