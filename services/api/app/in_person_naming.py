"""Propose names for "Speaker A/B/…" of an in-person recording; nothing is applied without approval.

The workspace text model reads the transcript and returns, per speaker label, a proposed name with
evidence: a name said aloud to them ("Thanks, Priya" → the next or addressed speaker), a
self-introduction ("I'm Marcus from finance"), or a match to people expected at the meeting
(calendar invitees, names the recorder listed). Output is constrained by a strict JSON schema and
then verified here: every quote must really occur in the transcript (its time is taken from the
transcript, not the model), labels must exist, and one name is never proposed for two speakers.
"""

from __future__ import annotations

import logging
import re
from typing import Any
from uuid import UUID

from meetings_contracts import TextGenerationRequest

from .in_person_models import SpeakerNameSuggestion

logger = logging.getLogger(__name__)
MAX_TRANSCRIPT_CHARS = 60_000
_CONFIDENCE_RANK = {"high": 0, "medium": 1, "low": 2}
_INTRO = re.compile(r"\b(i'?m|i am|my name|this is|thanks|thank you|over to you|go ahead|welcome)\b", re.IGNORECASE)
_KINDS = ["addressed", "self_introduction", "expected_person", "invitee"]
NAMING_SCHEMA: dict[str, Any] = {
    "type": "object", "additionalProperties": False, "required": ["speakers"],
    "properties": {"speakers": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["speaker", "name", "confidence", "reason", "evidence"],
        "properties": {
            "speaker": {"type": "string"},
            "name": {"type": ["string", "null"]},
            "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
            "reason": {"type": "string"},
            "evidence": {"type": "array", "items": {
                "type": "object", "additionalProperties": False, "required": ["quote", "at_seconds", "kind"],
                "properties": {"quote": {"type": "string"}, "at_seconds": {"type": "number"},
                               "kind": {"type": "string", "enum": _KINDS}},
            }},
        },
    }}},
}
SYSTEM_PROMPT = (
    "You identify who is speaking in a transcript of an in-person meeting. Speakers are labelled 'Speaker A', "
    "'Speaker B', and so on. For each label, propose the person's name only from evidence in the transcript: "
    "(1) someone addresses them by name ('Thanks, Priya' usually names the speaker who talks next or the one "
    "being answered), (2) they introduce themselves ('I'm Marcus'), (3) a name from the expected-people list "
    "fits the evidence. Quote the exact words as evidence (copy them verbatim from one line) with that line's "
    "time in seconds. Use name=null when unsure. Never guess from voice, role or topic alone. confidence: "
    "high = self-introduction or clearly addressed more than once; medium = addressed once; low = weak hint."
)


def transcript_lines(segments: list[Any]) -> list[str]:
    return [f"[{segment.start_seconds:.0f}s] {segment.raw_speaker or 'Speaker'}: {segment.text}" for segment in segments]


def _bounded(lines: list[str], names: list[str]) -> str:
    """The transcript, or its start plus the lines most likely to carry names when it is long."""
    text = "\n".join(lines)
    if len(text) <= MAX_TRANSCRIPT_CHARS:
        return text
    lowered = [name.casefold() for name in names]
    head, used, keep = [], 0, set()
    for index, line in enumerate(lines):
        if used + len(line) > MAX_TRANSCRIPT_CHARS // 2:
            break
        head.append(index)
        used += len(line) + 1
    for index, line in enumerate(lines):
        folded = line.casefold()
        if _INTRO.search(line) or any(name.split()[0] in folded for name in lowered if name):
            keep.update({index - 1, index, index + 1})
    extra = sorted(item for item in keep if 0 <= item < len(lines) and item not in head)
    chosen, budget = [], MAX_TRANSCRIPT_CHARS // 2
    for index in extra:
        if budget - len(lines[index]) < 0:
            break
        chosen.append(index)
        budget -= len(lines[index]) + 1
    return "\n".join(lines[index] for index in sorted({*head, *chosen}))


async def suggest_names(providers: Any, *, meeting_id: UUID, segments: list[Any], expected: list[str],
                        invitees: list[str]) -> list[dict[str, Any]]:
    """Validated suggestions as stored dicts (``state`` "suggested"); [] when there is nothing to propose."""
    labels = sorted({segment.raw_speaker for segment in segments if segment.raw_speaker})
    if len(labels) < 1 or labels == ["Speaker"]:
        return []
    people = list(dict.fromkeys([*expected, *invitees]))
    prompt = (f"Speaker labels: {', '.join(labels)}.\n"
              f"Expected people (may be incomplete; not everyone listed spoke): {', '.join(people) or 'none given'}.\n"
              "Invitees came from the calendar; names typed by the recorder are expected people.\n\n"
              "Transcript:\n" + _bounded(transcript_lines(segments), people))
    _, result = await providers.generate_text(TextGenerationRequest(
        system_prompt=SYSTEM_PROMPT, prompt=prompt, temperature=0, max_output_tokens=2000,
        response_schema=NAMING_SCHEMA,
        metadata={"purpose": "in_person_speaker_naming", "meeting_id": str(meeting_id)},
    ))
    return validate_suggestions(result.structured_output, segments=segments, labels=labels,
                                invitees=invitees, expected=expected)


def _norm(value: str) -> str:
    return " ".join(re.sub(r"[“”\"'‘’]", "", value).casefold().split())


def _find_quote(quote: str, segments: list[Any], hint: float) -> Any | None:
    """The transcript line containing ``quote`` closest to the model's time hint."""
    wanted = _norm(quote)
    if len(wanted) < 3:
        return None
    matches = [segment for segment in segments if wanted in _norm(segment.text)]
    return min(matches, key=lambda segment: abs(segment.start_seconds - hint)) if matches else None


def validate_suggestions(output: object, *, segments: list[Any], labels: list[str], invitees: list[str],
                         expected: list[str]) -> list[dict[str, Any]]:
    items = output.get("speakers") if isinstance(output, dict) else None
    found: dict[str, SpeakerNameSuggestion] = {}
    for item in items if isinstance(items, list) else []:
        suggestion = _one(item, segments, labels, invitees, expected)
        if suggestion is None:
            continue
        speaker, parsed = suggestion
        current = found.get(speaker)
        if current is None or _CONFIDENCE_RANK[parsed.confidence] < _CONFIDENCE_RANK[current.confidence]:
            found[speaker] = parsed
    return [{"speaker": speaker, **suggestion.model_dump(), "state": "suggested"}
            for speaker, suggestion in sorted(_unique_names(found).items())]


def _one(item: object, segments: list[Any], labels: list[str], invitees: list[str],
         expected: list[str]) -> tuple[str, SpeakerNameSuggestion] | None:
    if not isinstance(item, dict):
        return None
    speaker = str(item.get("speaker") or "").strip()
    name = " ".join(str(item.get("name") or "").split())[:120]
    confidence = item.get("confidence") if item.get("confidence") in _CONFIDENCE_RANK else "low"
    if speaker not in labels or not name or name.casefold() in {label.casefold() for label in labels}:
        return None
    evidence = []
    for raw in item.get("evidence") if isinstance(item.get("evidence"), list) else []:
        if not isinstance(raw, dict) or raw.get("kind") not in _KINDS:
            continue
        hint = raw.get("at_seconds") if isinstance(raw.get("at_seconds"), (int, float)) else 0.0
        line = _find_quote(str(raw.get("quote") or ""), segments, float(hint))
        if line is None:
            continue  # a quote that is not in the transcript is not evidence
        kind = raw["kind"]
        if kind in {"expected_person", "invitee"}:
            pool = invitees if kind == "invitee" else expected
            if not any(_norm(person) == _norm(name) or _norm(person).split()[0] == _norm(name).split()[0] for person in pool if person.strip()):
                continue
        evidence.append({"quote": str(raw.get("quote"))[:300], "at_seconds": round(float(line.start_seconds), 2), "kind": kind})
    if not evidence:
        return None
    if not any(item["kind"] in {"addressed", "self_introduction"} for item in evidence):
        confidence = "low"  # a list of expected people alone can't say who is who
    reason = " ".join(str(item.get("reason") or "").split())[:300] or "Named in the conversation"
    return speaker, SpeakerNameSuggestion(name=name, confidence=confidence, reason=reason, evidence=evidence[:5])


def _unique_names(found: dict[str, SpeakerNameSuggestion]) -> dict[str, SpeakerNameSuggestion]:
    """One name for one voice: the strongest claim keeps it; a tie keeps neither."""
    by_name: dict[str, list[str]] = {}
    for speaker, suggestion in found.items():
        by_name.setdefault(suggestion.name.casefold(), []).append(speaker)
    result = dict(found)
    for speakers in by_name.values():
        if len(speakers) < 2:
            continue
        ranked = sorted(speakers, key=lambda speaker: _CONFIDENCE_RANK[found[speaker].confidence])
        best = _CONFIDENCE_RANK[found[ranked[0]].confidence]
        winners = [speaker for speaker in ranked if _CONFIDENCE_RANK[found[speaker].confidence] == best]
        for speaker in speakers:
            if len(winners) > 1 or speaker != winners[0]:
                result.pop(speaker, None)
    return result
