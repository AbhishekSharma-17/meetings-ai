# Meetings AI SaaS build sequence

This separates built product capabilities from the remaining production gates.
Live capture, speaker quality, and email delivery remain **unvalidated** while
testing is deferred. Billing or signup must not be enabled before isolation.

| Stage | User-visible capability | Required backend boundary | Status |
| --- | --- | --- | --- |
| 0. Core meeting workflow | Bot dispatch, transcript, reviewed MOM, manual delivery | Persisted meeting and credential records | Built locally; live outcomes still need validation |
| 1. Workspace foundation | Edit organization profile, see people and roles | Organization, user, membership and credential records | Built locally |
| 2. Tenant isolation | Private organization data | Ownership records for meetings/providers, organization defaults, scoped API/worker and knowledge queries, cross-tenant denial tests | Application API boundary and workspace create/switch built; hosted RLS remains |
| 3. Accounts and roles | Email/password login, admin-generated temporary passwords, first-login rotation and owner/admin/member/viewer boundaries | Local sessions, sign-in throttling, audit, role changes and membership removal are built; external OIDC and invitation acceptance remain | Local lifecycle built; production identity pending |
| 4. Team operations | Calendar scheduling, shared templates, delivery policies, retention controls | Durable queue, policy enforcement, deletion/export, observability and backups | Planned |
| 5. Agentic knowledge | Named bases, meeting assignment, private/org/specific sharing, saved chats with per-user export/delete, selectable text model, source-linked Q&A | Canonical records plus manually refreshed, organization-scoped hybrid index are built; background indexing, query planning, linked topic pages and automatic retention remain | Source-linked hybrid workflow built; deeper agent planned |
| 6. Commercial SaaS | Plans, usage visibility, billing, self-serve setup | Metered usage, quotas, payment webhooks, dunning, tax/invoicing choices | Planned; no gateway selected |

## Isolation boundary and remaining work

The API now resolves an organization from the signed-in account and scopes
meetings, transcripts, MOM, delivery, provider profiles/defaults, knowledge,
workspace listings, and worker processing to that organization. Schema v13
backfills ownership for historical records. Foreign resource IDs return 404;
two-organization API tests cover reads, mutations, search, and delivery gates.
This is an application boundary, not hosted Supabase RLS. The browser has no
direct table access or service-role key.

The workspace contact email is metadata only. It does not alter the Resend
sender or recipients. Local account roles gate admin routes and knowledge
sharing inside their organization. Users can create/switch workspaces from the
profile menu, and an existing account can be added to another workspace without
replacing its password. Owners can promote other owners/admins, admins can
manage members/viewers, and removal immediately invalidates that workspace's
active session. Cross-workspace accounts cannot have their global password
reset by a single workspace's admin. The local password system still needs a
production identity lifecycle and hosted RLS tests before public onboarding.

Do not connect a public Supabase project or expose its tables until grants and
RLS policies are written and tested for two tenants. Keep the FastAPI policy
boundary in place even when PostgreSQL is hosted by Supabase.

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
  guessed from local development.
