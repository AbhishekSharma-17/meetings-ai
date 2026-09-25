# Meeting knowledge: source-linked hybrid retrieval

The current local flow is:

```text
Meeting assigned to one named base, tagged, and explicitly opted in
  → completed capture and finalized timestamped transcript
  → reviewed speaker labels and approved/sent MOM facts
  → durable background reindex job with the configured embedding provider
  → base-scoped lexical or hybrid retrieval
  → optional query planning for complex comparison/timeline questions
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

Completed meeting changes queue a durable `knowledge_index_jobs` row. A
single-instance worker refreshes one base at a time, retries provider failures
with backoff, and exposes pending/running/failed/succeeded status in AI knowledge.
An admin or base creator can also call `POST /v1/knowledge-bases/{id}/reindex`.
It batches up to 2,000 eligible sources from the
newest 200 meetings through the workspace's selected embedding profile. It
atomically replaces that base's previous index only after every embedding call
succeeds. `GET /v1/knowledge-bases/{id}/index` reports the count, profile, model,
and last indexed time plus the background job state and error. The index stores vectors, source IDs, and source
fingerprints—not transcript text. Retrieval ranks indexed sources with cosine
similarity and merges them with lexical results; every semantic hit must match a
current canonical source fingerprint and the active embedding provider/model.
Without a valid index or provider, retrieval is lexical. This is a bounded
single-worker implementation using JSON vectors in PostgreSQL, not a pgvector
service or multi-replica job queue.

Opt-out, tag changes, reassignment, transcript replacement, speaker correction,
and MOM save purge that meeting's vectors. Deleting an embedding profile also
purges vectors produced by it. Those sources remain searchable
lexically where still eligible; the background job restores semantic coverage
when the embedding provider is available. A
concurrent mutation during a reindex may leave an unusable stale vector, but
fingerprint validation prevents it from being cited. A user can export or delete
their own saved conversation; deletion removes its stored answer and citation
rows, but cannot revoke downloaded copies. Opting out, reassigning a meeting,
or changing its transcript, speaker labels, or MOM removes saved conversations
that cite that meeting so stale copied evidence is not shown. Deleting the
meeting does the same. The retention policy can separately expire old chats.
An unsent MOM can be deleted independently; the transcript remains, while
indexed MOM facts and affected saved answers are cleared. A sent MOM cannot be
deleted alone because the delivered version is part of the email history.

Deleting a knowledge base removes its sharing entries, index rows, and all
saved conversations and messages in one transaction. The underlying meetings,
transcripts, and MOMs remain, but their AI knowledge opt-in is switched off and
the base assignment is removed. Only a base creator or workspace admin can do
this. Downloaded copies cannot be recalled.

The evidence map is built live from canonical sources: literal meeting tags form
topic groups, and named transcript turns form speaker-label groups. A confirmed
speaker-to-email match can join evidence across meetings. Without confirmation,
the same name in separate meetings remains separate and is shown as unverified.
Each group previews exact, timestamped transcript evidence; it does not infer
topics or identities from an LLM.

The wiki also shows clickable links between meetings that share explicit tags
or a speaker email confirmed in both meetings. Each link shows its reason;
unverified same-name speakers never create identity links. For complex Ask AI
questions containing comparison, cross-meeting, or timeline language, the
selected text model may generate up to three bounded search strings. Each
search runs through the same tenant, base-sharing, opt-in, and canonical-source
checks. The final answer still requires exact retrieved citations. Simple
questions use the original single search to avoid an extra model call.

Admins may explicitly enable per-workspace retention for meeting records,
saved chats, and audit events (minimum 30 days); every category defaults to
indefinite retention. The hourly worker deletes only terminal meetings and
asks Vexa to erase capture artifacts before deleting the product record. A
Vexa error preserves the product record for retry. Manual meeting deletion
requires typed confirmation in the UI and uses the same upstream-first path.
Sent emails and downloaded exports cannot be recalled, and database/object
storage backup retention is a separate deployment policy.

Creators and admins can share a base with everyone in their organization or
specific members. Members can search only accessible named bases and open only
completed, cited meeting transcripts in those bases. Admins retain access to
all bases. The application API scopes index rows by selected organization; a
two-organization denial test covers the index endpoints. Hosted database RLS,
production identity, and end-to-end tenant tests remain release gates.

Current limits: candidate selection scans at most the 200 newest eligible
meetings; the search response reports truncation. Follow-up retrieval includes
the previous user question. There is no inferred entity graph, full linked
topic/person page system, vector database acceleration, or real-meeting
recall/factuality evaluation. Before release,
measure retrieval, answer quality, speaker accuracy, privacy, latency, and cost
on consented multi-speaker meetings.
