# Knowledge chat, MOM guidance, and usage visibility

## Ask AI

Choose a named knowledge base, then use **Ask AI** for a saved conversation, **Wiki** for linked meeting pages, or **Sources** for direct search. Each answer retrieves current, permission-checked transcript and approved-MOM evidence; hybrid search combines lexical and indexed semantic results when an embedding index exists. The answer model receives up to six recent chat messages for reference resolution. Retrieval includes the last three user questions and can plan additional searches for comparisons and timelines. This is bounded conversation memory, not an unlimited long-term agent memory. Answers must cite retrieved source labels, and the UI links each citation to its transcript turn.

The chat model picker lists workspace-scoped text providers without exposing credentials. OpenAI and OpenRouter profiles fetch a live model catalog server-side, cached for ten minutes. A selected model is checked against that catalog before a call; custom compatible endpoints use their configured model. For OpenAI chat, `gpt-6-luna` is suggested when listed; an existing saved MOM default is **not** silently changed. Chat model choice applies to that browser session, while each saved assistant message records the model actually used.

## MOM formats

At meeting creation or in its MOM panel, choose balanced minutes, decisions/actions, client recap, discovery notes, or custom focus. Organizer instructions and up to eight named focus fields guide the next draft. Supported focus fields become labelled discussion points; the transcript remains the evidence source, and unsupported content should be omitted. Changing the format after a draft is generated requires regeneration. Sent MOMs remain locked.

Evidence links display elapsed time from the first captured transcript turn. Internal capture segment IDs remain stored for validation but are not meant for recipient-facing copy. Where capture timestamps are absolute, the transcript turn tooltip shows the local wall-clock time.

## Invitations and usage

An invitation attempts Resend delivery from the configured Meetings AI sender to the teammate's email. New users get a generated temporary password in the email and must change it at first sign-in. If delivery is unavailable or fails, the admin receives an explicit one-time copy fallback; a successful send does not return the password. The sign-in URL comes from `WEB_ORIGIN`, which must be the recipient-accessible HTTPS origin in production. Existing users are notified to use their current password.

Workspace Operations now includes people, meetings, saved chats, job failures, and a scrollable audit panel. The usage ledger records provider-reported tokens for MOM generation, Ask AI answers/query plans, and embedding index/search calls. Published list rates produce *estimated* USD only for known models; all other calls are marked unpriced. It groups model calls by meeting and shows recent events. Vexa transcription duration/cost, provider discounts, taxes, and actual invoice totals are **not** measured here yet. Historical model calls before this schema version are not backfilled.
