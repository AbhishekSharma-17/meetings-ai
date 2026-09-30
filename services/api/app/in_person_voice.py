"""Voice samples in the final pass of an in-person recording: whose samples to send, and what came back.

Only people expected at the meeting are considered — the recorder, calendar invitees (matched to
workspace members by email, then by name) and names the recorder typed — and only members of the
meeting's workspace who saved a sample there. The provider gets opaque keys ("person_1"), never names.

A voice match becomes a speaker-name SUGGESTION with evidence "matched their saved voice sample"; like
every suggestion it changes nothing until someone approves it.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from .in_person_reconcile import GlobalSegment
from .in_person_stt import MAX_KNOWN_SPEAKERS, KnownSpeaker

VOICE_EVIDENCE = "voice_sample"
_QUOTE_CHARS = 300
_CONFIDENCE_RANK = {"high": 0, "medium": 1, "low": 2}


@dataclass(frozen=True)
class VoiceReference:
    known: KnownSpeaker
    user_id: UUID
    display_name: str


def _norm(value: str | None) -> str:
    return " ".join((value or "").casefold().split())


def pick_attendees(identities: list[tuple[UUID, str, str | None]], *, recorder_id: UUID, expected: list[str],
                   invitees: list[dict[str, Any]], limit: int = MAX_KNOWN_SPEAKERS) -> list[UUID]:
    """Members with a sample who are expected at the meeting, recorder first, at most ``limit``."""
    by_id = {user_id: (name, email) for user_id, name, email in identities}
    emails = {_norm(person.get("email")) for person in invitees if isinstance(person, dict) and person.get("email")}
    names = [_norm(name) for name in [*expected, *(str(person.get("name") or "") for person in invitees
                                                   if isinstance(person, dict))] if _norm(name)]
    chosen: list[UUID] = [recorder_id] if recorder_id in by_id else []
    chosen += [user_id for user_id, (_, email) in by_id.items() if email and _norm(email) in emails]
    for name in names:
        chosen += _by_name(by_id, name)
    return list(dict.fromkeys(chosen))[:limit]


def _by_name(by_id: dict[UUID, tuple[str, str | None]], name: str) -> list[UUID]:
    """Only an exact full-name match: a guessed first name could send an absent member's sample."""
    return [user_id for user_id, (display, _) in by_id.items() if _norm(display) == name]


def references(samples: list[Any]) -> list[VoiceReference]:
    """Opaque keys in a stable order for loaded samples (``voice_samples.StoredSample``)."""
    return [VoiceReference(KnownSpeaker(f"person_{index + 1}", sample.mime_type, sample.data), sample.user_id,
                           sample.display_name) for index, sample in enumerate(samples)]


def voice_matches(segments: list[GlobalSegment], refs: list[VoiceReference]) -> dict[str, VoiceReference]:
    """Recording-wide label → the person whose sample the provider matched, one person per label.

    A label takes the key it spoke most seconds under; a key claimed by two labels stays with the
    label that spoke longest under it.
    """
    by_key = {ref.known.key: ref for ref in refs}
    seconds: dict[str, Counter[str]] = {}
    for item in segments:
        if item.label and item.known in by_key:
            seconds.setdefault(item.label, Counter())[item.known] += max(item.end - item.start, 0.01)
    best = {label: counts.most_common(1)[0] for label, counts in seconds.items()}
    owner: dict[str, tuple[str, float]] = {}
    for label, (key, spoken) in best.items():
        if key not in owner or spoken > owner[key][1]:
            owner[key] = (label, spoken)
    return {label: by_key[key] for key, (label, _) in owner.items()}


def voice_suggestions(matches: dict[str, VoiceReference], transcript: list[Any]) -> list[dict[str, Any]]:
    """Stored suggestion dicts for voice matches; the quote is that speaker's first line."""
    first: dict[str, Any] = {}
    for segment in transcript:
        if segment.raw_speaker and segment.raw_speaker not in first and (segment.text or "").strip():
            first[segment.raw_speaker] = segment
    result = []
    for label, ref in sorted(matches.items()):
        line = first.get(f"Speaker {label}")
        if line is None:
            continue
        result.append({
            "speaker": f"Speaker {label}", "name": ref.display_name[:120], "confidence": "medium",
            "reason": f"Matched {ref.display_name}'s saved voice sample"[:300],
            "evidence": [{"quote": line.text.strip()[:_QUOTE_CHARS], "at_seconds": round(float(line.start_seconds), 2),
                          "kind": VOICE_EVIDENCE}],
            "state": "suggested",
        })
    return result


def is_voice_suggestion(item: dict[str, Any]) -> bool:
    return any(isinstance(evidence, dict) and evidence.get("kind") == VOICE_EVIDENCE for evidence in item.get("evidence") or [])


def merge(transcript_based: list[dict[str, Any]], voice: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Voice matches win their speaker; agreeing transcript evidence is kept and raises confidence.

    One name, one voice: a transcript-based suggestion of a voice-matched name for another speaker is dropped.
    """
    by_speaker = {item["speaker"]: item for item in voice}
    voice_names = {_norm(item["name"]) for item in voice}
    merged: dict[str, dict[str, Any]] = {}
    for item in transcript_based:
        match = by_speaker.get(item["speaker"])
        if match is None:
            if _norm(item.get("name")) not in voice_names:
                merged[item["speaker"]] = item
            continue
        if _norm(item.get("name")) == _norm(match["name"]):
            reason = f"{match['reason']}. {item.get('reason') or ''}".strip(" .")[:300]
            merged[item["speaker"]] = {**match, "confidence": "high", "reason": reason,
                                       "evidence": [*match["evidence"], *(item.get("evidence") or [])][:5]}
    for speaker, item in by_speaker.items():
        merged.setdefault(speaker, item)
    return [merged[speaker] for speaker in sorted(merged)]
