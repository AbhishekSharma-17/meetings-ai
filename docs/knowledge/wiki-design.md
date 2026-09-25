# Connected meeting wiki: product architecture

## Decision

The source of truth remains the meeting, its timestamped transcript turns, reviewed
speaker names, and approved MOM. A knowledge base is a named collection of meetings.
The wiki presents typed connections among those records before any model-generated
interpretation: `knowledge base → meeting → transcript turn / approved MOM fact`.
Tags, dates, participants, actions, and decisions are filters and links, not opaque
embedding metadata. The first connected source-map API now exposes completed,
opted-in meetings and approved MOM facts, with shared-tag relations.

## Query flow to build next

1. Resolve the selected knowledge base and user access **before** retrieving any data.
2. Classify the question as exact lookup (person/date/phrase), comparison across
   meetings, or broad synthesis. Include saved-chat context only to resolve references.
3. Use structured filters and exact/full-text search for names, dates, decisions,
   and transcript turns. Follow links to adjacent meetings and MOM facts. Fetch the
   full source span around a selected turn so a short snippet is not misread.
4. For broad synthesis, create a bounded outline from the meeting summaries, then
   drill into the meetings and transcript spans behind each claim. A model must
   return source identifiers that were actually retrieved; reject invented citations.
5. Recheck access and current opt-in state at answer time. Speaker corrections and
   revoked sharing must take effect without stale answers being silently reused.

This uses a small, interpretable source graph. It is **not** a promise that the
current lexical search already performs multi-hop reasoning. Search quality will be
measured with questions about names, dates, cross-meeting changes, and broad themes.

## Why vectors are optional

Exact names, dates, and quoted commitments need precise matching and typed filters.
Semantic retrieval may help paraphrases once the evaluation set shows a gap. It can
be added beside PostgreSQL full-text search, with organization and knowledge-base
filters applied before ranking. Embeddings must be regenerated if the model changes.
Do not introduce a separate vector database solely to represent wiki relationships.

Anthropic's contextual retrieval work supports combining lexical and semantic
signals for large corpora rather than relying on embeddings alone. Microsoft's
GraphRAG distinguishes local entity questions from costly global synthesis over
community summaries. Those are useful design inputs, but a full generated graph
is premature until our meeting-specific evaluation proves the simpler typed graph
is insufficient.

Sources: [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval),
[Microsoft GraphRAG query modes](https://microsoft.github.io/graphrag/query/overview/),
[Supabase vector columns](https://supabase.com/docs/guides/ai/vector-columns).

## Supabase boundary

Supabase can host PostgreSQL and Auth. The FastAPI service stays the policy and
model-provider boundary; the browser does not receive a service-role key or direct
table grants. Before linking a hosted project, the database needs complete
organization scoping plus explicit RLS/grants tests. Supabase's guidance is to
enable RLS on every exposed table and test allow/deny operations. We leave remote
linking and migration unapplied until those tests exist.

Source: [Supabase Row Level Security guide](https://supabase.com/docs/guides/database/postgres/row-level-security).
