# Meeting knowledge: first slice and target wiki

The local application supports this source-linked path:

```text
New meeting: named knowledge base + tags + explicit opt-in
  → complete capture
  → finalized, timestamped transcript turns
  → human-reviewed speaker labels and approved/sent MOM facts
  → base-scoped lexical search with optional tag filter
  → draft AI answer using that base's text profile or the workspace default
  → citations opening the exact transcript turn
  → per-user saved conversation in the selected base
```

Search reads the canonical meeting, transcript, and MOM records at query time.
It includes only completed, opted-in meetings, finalized turns, and
approved/sent MOM questions, actions, and speaker contributions with existing
segment evidence. A speaker correction, MOM approval change, or opt-out is
reflected in the next search without a stale copy to re-index. Each source
contains the meeting title and ID, meeting date (join date when known,
otherwise record date), speaker label, transcript offset, tags, and stable
segment ID. An AI answer must cite retrieved source IDs; a missing or invented
ID is rejected. The answer remains a draft; an exact citation is not proof
that a diarized person is correctly identified.

Creators and admins can share a base with everyone in their organization
or specific members. Members can search only accessible named bases and open
only completed, cited meeting transcripts in those bases. Admins retain access
to all bases. A temporary-password account must change its password before
access. The application API now scopes meetings, providers and knowledge by
the selected organization; hosted database row-level security remains work.

Current limits: matching is lexical and scans at most the 200 newest eligible
meetings per query. The search response says when the scope was truncated.
Chats are saved per user in named bases; follow-up retrieval includes the last
user question, but every answer must cite fresh evidence. No
embedding index, vector search, entity graph, linked topic/person pages, or
model-led query planning have been implemented. The embedding provider runtime
does support OpenAI and OpenAI-compatible endpoints, but retrieval does not
call it yet. Existing answer text is not
revoked when a meeting is later opted out. Treat exported/copied answers as
separate records under a future retention policy.

Before calling this a multi-customer wiki, complete hosted row-level security
and production identity. The application API scopes meetings, transcripts,
MOMs, providers, retrieval, chat and worker jobs by organization and has
two-organization denial tests. Next add a durable organization-scoped knowledge index
with change events for opt-in, transcript correction, MOM approval and deletion.
Use the configurable embedding provider for semantic retrieval, retain the
exact segment citation contract, and show linked topic/person/decision pages
only where evidence supports the relation. Evaluate recall, factuality,
speaker accuracy, and privacy on consented real meetings before release.
