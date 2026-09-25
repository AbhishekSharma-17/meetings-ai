# Meeting knowledge: first slice and target wiki

The local pilot now supports this source-linked path:

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

Creators and admins can share a base with everyone in this local organization
or specific members. Members can search only accessible named bases and open
only completed, cited meeting transcripts in those bases. Admins retain access
to all bases. A temporary-password account must change its password before
access. This is not yet a multi-organization tenant boundary.

Current limits: matching is lexical and scans at most the 200 newest eligible
meetings per query. The search response says when the scope was truncated.
Chats are saved per user in named bases; follow-up retrieval includes the last
user question, but every answer must cite fresh evidence. No
embeddings, vector store, entity graph, linked topic/person pages, or model-led
query planning have been implemented. Existing answer text is not
revoked when a meeting is later opted out. Treat exported/copied answers as
separate records under a future retention policy.

Before calling this a multi-customer wiki, complete tenant isolation. Scope
every meeting, transcript, MOM, provider profile, retrieval request, chat
history, and background job by authenticated organization; test cross-tenant
denial and deletion. Then add a durable organization-scoped knowledge index
with change events for opt-in, transcript correction, MOM approval and deletion.
Use the configurable embedding provider for semantic retrieval, retain the
exact segment citation contract, and show linked topic/person/decision pages
only where evidence supports the relation. Evaluate recall, factuality,
speaker accuracy, and privacy on consented real meetings before release.
