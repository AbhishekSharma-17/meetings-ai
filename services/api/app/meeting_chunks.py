"""Build knowledge-base chunks from canonical, permission-checked meeting evidence.

Each chunk is paired with the exact ``KnowledgeSource`` it cites, so semantic
hits map back onto the same citation shape the web client already renders:
transcript chunks are single-speaker turns carrying every segment id they span;
MOM facts keep their own source and evidence segment ids.
"""

from __future__ import annotations

from collections import OrderedDict

from .chunking import ChunkDraft, TurnSegment, group_turns, turn_source_id
from .knowledge_service import KnowledgeSource

_MOM_LABELS = {"question": "Question asked", "action": "Action item", "contribution": "Speaker contribution",
               "decision": "Decision", "summary": "Meeting summary"}


def meeting_drafts(sources: list[KnowledgeSource]) -> list[tuple[ChunkDraft, KnowledgeSource]]:
    """Canonical sources (as returned by candidate_sources) -> (chunk, citation) pairs."""
    by_meeting: OrderedDict[str, list[KnowledgeSource]] = OrderedDict()
    for source in sources:
        by_meeting.setdefault(str(source.meeting_id), []).append(source)
    pairs: list[tuple[ChunkDraft, KnowledgeSource]] = []
    for meeting_id, items in by_meeting.items():
        first = items[0]
        date = (first.meeting_joined_at or first.meeting_created_at).date().isoformat()
        transcript = [item for item in items if item.kind == "transcript"]
        by_source = {item.source_id: item for item in transcript}
        previous = ""
        for turn in group_turns([TurnSegment(
            source_id=item.source_id, segment_id=item.segment_id, speaker=item.speaker,
            start_seconds=item.start_seconds, end_seconds=item.end_seconds, text=item.text,
        ) for item in transcript]):
            head = by_source[turn[0].source_id]
            text = " ".join(item.text.strip() for item in turn)
            citation = head if len(turn) == 1 else head.model_copy(update={
                "source_id": turn_source_id(meeting_id, turn), "text": text,
                "end_seconds": turn[-1].end_seconds,
                "evidence_segment_ids": [item.segment_id for item in turn],
            })
            speaker = head.speaker or "Unidentified speaker"
            pairs.append((ChunkDraft(
                source_type="transcript", source_id=citation.source_id, title=head.meeting_title,
                content=f"{speaker}: {text}", position=len(pairs), meeting_id=meeting_id,
                hint=previous,
                details={
                    "heading_path": [head.meeting_title, date, speaker], "kind": "transcript",
                    "segment_id": head.segment_id, "segment_ids": [item.segment_id for item in turn],
                    "start_seconds": head.start_seconds, "end_seconds": turn[-1].end_seconds,
                    "speaker": head.speaker, "meeting_date": date, "tags": list(head.tags),
                },
            ), citation))
            previous = f"{speaker}: {text}"[:240]
        for item in items:
            if item.kind == "transcript":
                continue
            label = _MOM_LABELS.get(item.kind, item.kind)
            pairs.append((ChunkDraft(
                source_type="mom", source_id=item.source_id, title=item.meeting_title,
                content=f"{label}: {item.text}", position=len(pairs), meeting_id=meeting_id,
                details={
                    "heading_path": [item.meeting_title, date, "Approved minutes"], "kind": item.kind,
                    "segment_id": item.segment_id, "evidence_segment_ids": list(item.evidence_segment_ids),
                    "start_seconds": item.start_seconds, "speaker": item.speaker, "meeting_date": date,
                    "tags": list(item.tags),
                },
            ), item))
    return pairs
