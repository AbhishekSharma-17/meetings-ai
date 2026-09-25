# Meeting knowledge: source-linked hybrid retrieval

The current local flow is:

```text
Meeting assigned to one named base, tagged, and explicitly opted in
  → completed capture and finalized timestamped transcript
  → reviewed speaker labels and approved/sent MOM facts
  → optional manual reindex with the configured embedding provider
  → base-scoped lexical or hybrid retrieval
  → draft answer from the selected text-generation provider
  → citations opening exact transcript turns
  → per-user saved conversation in that base
```

Search always reads canonical meeting, transcript, and MOM records. It includes
only completed, opted-in meetings, finalized turns, and approved/sent MOM facts
with segment evidence. Each citation carries meeting and segment IDs, meeting
date, speaker label, timestamp offset, and tags. An AI answer must cite retrieved
source IDs; missing or invented IDs are rejected. A valid citation does not
prove that diarization identified a person correctly.

An admin or base creator can call `POST /v1/knowledge-bases/{id}/reindex` (or use
the button in AI knowledge). It batches up to 2,000 eligible sources from the
newest 200 meetings through the workspace's selected embedding profile. It
atomically replaces that base's previous index only after every embedding call
succeeds. `GET /v1/knowledge-bases/{id}/index` reports the count, profile, model,
and last indexed time. The index stores vectors, source IDs, and source
fingerprints—not transcript text. Retrieval ranks indexed sources with cosine
similarity and merges them with lexical results; every semantic hit must match a
current canonical source fingerprint and the active embedding provider/model.
Without a valid index or provider, retrieval is lexical. This is a bounded
synchronous implementation using JSON vectors in PostgreSQL, not a pgvector or
background-worker deployment.

Opt-out, tag changes, reassignment, transcript replacement, speaker correction,
and MOM save purge that meeting's vectors. Deleting an embedding profile also
purges vectors produced by it. Those sources remain searchable
lexically where still eligible; manual reindex restores semantic coverage. A
concurrent mutation during a reindex may leave an unusable stale vector, but
fingerprint validation prevents it from being cited. A user can export or delete
their own saved conversation; deletion removes its stored answer and citation
rows, but cannot revoke downloaded copies. Existing saved answer text is **not**
automatically revoked on meeting opt-out; workspace retention policy and
automated deletion remain to build.

Deleting a knowledge base removes its sharing entries, index rows, and all
saved conversations and messages in one transaction. The underlying meetings,
transcripts, and MOMs remain, but their AI knowledge opt-in is switched off and
the base assignment is removed. Only a base creator or workspace admin can do
this. Downloaded copies cannot be recalled.

Creators and admins can share a base with everyone in their organization or
specific members. Members can search only accessible named bases and open only
completed, cited meeting transcripts in those bases. Admins retain access to
all bases. The application API scopes index rows by selected organization; a
two-organization denial test covers the index endpoints. Hosted database RLS,
production identity, and end-to-end tenant tests remain release gates.

Current limits: candidate selection scans at most the 200 newest eligible
meetings; the search response reports truncation. Follow-up retrieval includes
the previous user question. There is no model-led query planning, entity graph,
linked topic/person pages, automated reindex scheduling, vector database
acceleration, or real-meeting recall/factuality evaluation. Before release,
measure retrieval, answer quality, speaker accuracy, privacy, latency, and cost
on consented multi-speaker meetings.
