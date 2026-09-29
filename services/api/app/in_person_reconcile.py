"""Join the parts of a long in-person recording into one transcript with consistent speakers.

Each provider request labels its own speakers (A, B, …), so the same person can be "A" in one part
and "B" in the next. Adjacent parts of one recorder stream share an overlap (the last chunk of a
part is the first of the next): a part's labels are matched to the running labels by how long they
speak at the same time in that overlap. Labels the overlap cannot settle (a person silent in the
overlap, or a new stream after a page reload) go to a continuity check by the workspace text model,
which may only map a label to an existing speaker or declare it new. The overlap is then cut in its
middle so no sentence appears twice.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from meetings_contracts import TextGenerationRequest

from .in_person_audio import Part
from .in_person_stt import RawSegment, SttResult, _letters

logger = logging.getLogger(__name__)
MIN_OVERLAP_SECONDS = 1.0
_CONTEXT_LINES = 12
_CONTINUITY_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["mappings"],
    "properties": {"mappings": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["label", "same_as"],
        "properties": {"label": {"type": "string"}, "same_as": {"type": ["string", "null"]}},
    }}},
}
_CONTINUITY_PROMPT = (
    "You check speaker continuity in a meeting transcript that was transcribed in parts. Speakers in the "
    "earlier part have final names like 'Speaker A'. Speakers in the next part have temporary labels like "
    "'new-A'. For each temporary label, say which earlier speaker it is (same_as = that name) only when the "
    "conversation makes it clear (they continue a sentence, answer as the same person, are addressed the same "
    "way); otherwise same_as = null. Never map two temporary labels to the same earlier speaker."
)


@dataclass(frozen=True)
class GlobalSegment:
    start: float
    end: float
    text: str
    label: str | None  # "A", "B", … across the whole recording; None when the part had no speaker labels


class _Labels:
    def __init__(self) -> None:
        self.count = 0

    def new(self) -> str:
        label = _letters(self.count)
        self.count += 1
        return label


async def reconcile(parts: list[tuple[Part, SttResult]], *, providers: Any, meeting_id: UUID,
                    language: str | None = None) -> list[GlobalSegment]:
    """One ordered transcript across all parts, with recording-wide speaker labels."""
    labels = _Labels()
    output: list[GlobalSegment] = []
    previous: Part | None = None
    for part, result in parts:
        shifted = [RawSegment(item.start + part.start_ms / 1000, item.end + part.start_ms / 1000, item.text, item.speaker)
                   for item in result.segments]
        same_stream = previous is not None and previous.stream_first_seq == part.stream_first_seq
        overlap_start = part.start_ms / 1000
        overlap_end = overlap_start + part.overlap_ms / 1000 if same_stream else overlap_start
        mapping: dict[str, str] = {}
        if same_stream and part.overlap_ms:
            before = [item for item in output if item.end > overlap_start and item.start < overlap_end]
            mapping = _overlap_mapping(before, shifted, overlap_start, overlap_end)
        unmapped = sorted({item.speaker for item in shifted if item.speaker and item.speaker not in mapping})
        if unmapped and output and any(item.label for item in output):
            mapping.update(await _continuity(providers, meeting_id, output, shifted, unmapped, mapping))
        for local in sorted({item.speaker for item in shifted if item.speaker} - set(mapping)):
            mapping[local] = labels.new()
        labels.count = max(labels.count, _label_count(mapping.values()))
        if same_stream and part.overlap_ms:
            cut = (overlap_start + overlap_end) / 2
            output = [item for item in output if item.start < cut]
            shifted = [item for item in shifted if item.start >= cut]
        output.extend(GlobalSegment(item.start, item.end, item.text, mapping.get(item.speaker) if item.speaker else None)
                      for item in shifted)
        previous = part
    return sorted(output, key=lambda item: (item.start, item.end))


def _label_count(values) -> int:
    highest = 0
    for value in values:
        index = 0
        for char in value:
            index = index * 26 + (ord(char) - 64)
        highest = max(highest, index)
    return highest


def _overlap_mapping(before: list[GlobalSegment], after: list[RawSegment], start: float, end: float) -> dict[str, str]:
    """Part-local label → running label, by seconds of simultaneous speech inside the overlap window."""
    scores: dict[tuple[str, str], float] = {}
    for new in after:
        if not new.speaker:
            continue
        for old in before:
            if not old.label:
                continue
            shared = min(new.end, old.end, end) - max(new.start, old.start, start)
            if shared > 0:
                scores[(new.speaker, old.label)] = scores.get((new.speaker, old.label), 0.0) + shared
    mapping: dict[str, str] = {}
    taken: set[str] = set()
    for (local, running), seconds in sorted(scores.items(), key=lambda item: -item[1]):
        if seconds < MIN_OVERLAP_SECONDS or local in mapping or running in taken:
            continue
        mapping[local] = running
        taken.add(running)
    return mapping


async def _continuity(providers: Any, meeting_id: UUID, output: list[GlobalSegment], shifted: list[RawSegment],
                      unmapped: list[str], mapping: dict[str, str]) -> dict[str, str]:
    """Ask the workspace text model which earlier speaker (if any) each unmapped label continues."""
    if providers is None:
        return {}
    earlier = [f"[Speaker {item.label}] {item.text}" for item in output if item.label][-_CONTEXT_LINES:]
    later = [f"[{'Speaker ' + mapping[item.speaker] if item.speaker in mapping else 'new-' + str(item.speaker)}] {item.text}"
             for item in shifted if item.speaker][:_CONTEXT_LINES]
    known = sorted({item.label for item in output if item.label})
    prompt = (f"Earlier speakers: {', '.join('Speaker ' + label for label in known)}.\n"
              f"Temporary labels to check: {', '.join('new-' + label for label in unmapped)}.\n\n"
              "End of the earlier part:\n" + "\n".join(earlier) + "\n\nStart of the next part:\n" + "\n".join(later))
    try:
        _, result = await providers.generate_text(TextGenerationRequest(
            system_prompt=_CONTINUITY_PROMPT, prompt=prompt, temperature=0, max_output_tokens=400,
            response_schema=_CONTINUITY_SCHEMA,
            metadata={"purpose": "in_person_speaker_continuity", "meeting_id": str(meeting_id)},
        ))
    except Exception as exc:  # noqa: BLE001 - optional check; unmatched speakers simply become new labels
        logger.warning("speaker continuity check failed for %s: %s", meeting_id, type(exc).__name__)
        return {}
    return _validated_continuity(result.structured_output, unmapped, known, set(mapping.values()))


def _validated_continuity(output: object, unmapped: list[str], known: list[str], taken: set[str]) -> dict[str, str]:
    mappings = output.get("mappings") if isinstance(output, dict) else None
    result: dict[str, str] = {}
    used = set(taken)
    for item in mappings if isinstance(mappings, list) else []:
        if not isinstance(item, dict):
            continue
        local = str(item.get("label") or "").removeprefix("new-").strip()
        target = str(item.get("same_as") or "").removeprefix("Speaker").strip()
        if local in unmapped and local not in result and target in known and target not in used:
            result[local] = target
            used.add(target)
    return result
