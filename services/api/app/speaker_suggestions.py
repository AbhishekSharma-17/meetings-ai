"""Suggest which email may belong to each named transcript speaker.

Suggestions are advisory only. Nothing here links an email to a voice: a person
approves each suggestion, and only that approval (the speaker-identity save)
creates the link. Invitees are never treated as verified attendees.

Matching works on normalised names (case, diacritics and punctuation removed)
and ranks evidence strictly:

- high:   the full name matches (same words in any order), or first and last name match
- medium: a unique first-name or last-name match, or the email local part spells the name
- low:    initials, a common nickname or a short first-name prefix

Within one strength, people from the meeting itself (invitees, organizer) outrank
the workspace directory. When two different people tie at the strongest level
found, nothing is suggested and the ambiguity is explained instead.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable, Literal

from pydantic import BaseModel, Field

Confidence = Literal["high", "medium", "low"]
CandidateSource = Literal["invite", "organizer", "workspace_member"]

_EMAIL = re.compile(r"[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+")
_GENERIC_SPEAKER = re.compile(r"^(?:speaker|participant|guest|unknown|user|seg|person|caller)[\s_-]*\d*$")
_HONORIFICS = frozenset({"mr", "mrs", "ms", "miss", "dr", "prof", "sir"})
_MIN_PREFIX = 3
_MAX_ALTERNATIVES = 5
# Common English short forms. Only used for low-confidence suggestions.
_NICKNAMES: dict[str, frozenset[str]] = {
    key: frozenset(value.split()) for key, value in {
        "abhi": "abhishek", "alex": "alexander alexandra alexis", "andy": "andrew", "ben": "benjamin",
        "bill": "william", "bob": "robert", "bobby": "robert", "chris": "christopher christina christine",
        "dan": "daniel", "danny": "daniel", "dave": "david", "ed": "edward", "greg": "gregory",
        "jen": "jennifer", "jenny": "jennifer", "jim": "james", "jimmy": "james", "joe": "joseph",
        "jon": "jonathan", "josh": "joshua", "kate": "katherine catherine kathryn", "katie": "katherine catherine",
        "kim": "kimberly", "liz": "elizabeth", "beth": "elizabeth", "matt": "matthew", "meg": "margaret megan",
        "mike": "michael", "nick": "nicholas", "pat": "patrick patricia", "rich": "richard", "rick": "richard",
        "rob": "robert", "sam": "samuel samantha", "steve": "steven stephen", "sue": "susan", "tim": "timothy",
        "tom": "thomas", "tony": "anthony", "vicky": "victoria", "will": "william", "zach": "zachary",
    }.items()
}
_SOURCE_LABEL: dict[str, str] = {"invite": "invitee", "organizer": "organizer", "workspace_member": "workspace member"}
_MEETING_SOURCES = frozenset({"invite", "organizer"})
_SOURCE_RANK = {"invite": 0, "organizer": 1, "workspace_member": 2}
_CONFIDENCE_RANK = {"high": 0, "medium": 1, "low": 2}


class SuggestionAlternative(BaseModel):
    email: str
    display_name: str
    source: CandidateSource


class SpeakerSuggestion(BaseModel):
    speaker: str
    status: Literal["suggested", "ambiguous"]
    email: str | None = None
    display_name: str | None = None
    source: CandidateSource | None = None
    confidence: Confidence | None = None
    reason: str
    alternatives: list[SuggestionAlternative] = Field(default_factory=list)


@dataclass(frozen=True)
class Candidate:
    email: str
    display_name: str
    source: CandidateSource


@dataclass(frozen=True)
class _Profile:
    candidate: Candidate
    name_tokens: tuple[str, ...]
    local_tokens: tuple[str, ...]
    local_joined: str


@dataclass(frozen=True)
class _Match:
    candidate: Candidate
    confidence: Confidence
    reason: str


def normalize_name(value: str) -> tuple[str, ...]:
    """Lower-case words without diacritics, punctuation or honorifics."""
    decomposed = unicodedata.normalize("NFKD", value)
    plain = "".join(char for char in decomposed if not unicodedata.combining(char)).casefold()
    words = re.sub(r"[^0-9a-z]+", " ", plain).split()
    return tuple(word for word in words if word not in _HONORIFICS)


def email_address(value: str | None) -> str | None:
    if not value:
        return None
    found = _EMAIL.search(value.strip())
    return found.group(0).lower() if found else None


def _local_tokens(email: str) -> tuple[str, ...]:
    local = email.split("@", 1)[0].split("+", 1)[0]
    return tuple(word for word in re.split(r"[._\-\d]+", local) if word)


def _profile(candidate: Candidate) -> _Profile:
    name = candidate.display_name if not email_address(candidate.display_name) else ""
    local = _local_tokens(candidate.email)
    return _Profile(candidate, normalize_name(name), tuple(normalize_name(" ".join(local))), "".join(local).lower())


def merge_candidates(candidates: Iterable[Candidate]) -> list[Candidate]:
    """One candidate per email, keeping the meeting-level source and the most descriptive name."""
    merged: dict[str, Candidate] = {}
    for candidate in candidates:
        email = email_address(candidate.email)
        if not email:
            continue
        current = merged.get(email)
        name = candidate.display_name.strip() or email
        if current is None:
            merged[email] = Candidate(email, name, candidate.source)
            continue
        best_source = min((current.source, candidate.source), key=_SOURCE_RANK.__getitem__)
        best_name = current.display_name if not email_address(current.display_name) else name
        merged[email] = Candidate(email, best_name, best_source)
    return list(merged.values())


def is_generic_speaker(speaker: str, bot_name: str | None) -> bool:
    tokens = normalize_name(speaker)
    if not tokens:
        return True
    if bot_name and tokens == normalize_name(bot_name):
        return True
    return bool(_GENERIC_SPEAKER.fullmatch(" ".join(tokens)))


def _who(candidate: Candidate) -> str:
    return f"{_SOURCE_LABEL[candidate.source]} {candidate.display_name}"


def _initials(tokens: tuple[str, ...]) -> str:
    return "".join(token[0] for token in tokens)


def _nickname_of(short: str, full: str) -> bool:
    return full in _NICKNAMES.get(short, frozenset())


def _match(speaker: tuple[str, ...], profile: _Profile) -> _Match | None:
    """The strongest evidence linking one speaker to one candidate, if any."""
    candidate, name = profile.candidate, profile.name_tokens
    if name and (speaker == name or (len(speaker) > 1 and sorted(speaker) == sorted(name))):
        return _Match(candidate, "high", f"Full name matches {_who(candidate)}")
    if name and len(speaker) > 1 and len(name) > 1 and speaker[0] == name[0] and speaker[-1] == name[-1]:
        return _Match(candidate, "high", f"First and last name match {_who(candidate)}")
    if name and len(name) == 1 and len(speaker) > 1 and speaker[0] == name[0]:
        return _Match(candidate, "medium", f"First name matches {_who(candidate)}")
    if name and len(speaker) == 1:
        word = speaker[0]
        if word == name[0]:
            return _Match(candidate, "medium", f"First name matches {_who(candidate)}")
        if len(name) > 1 and word == name[-1]:
            return _Match(candidate, "medium", f"Last name matches {_who(candidate)}")
    local = profile.local_tokens
    if local and (speaker == local or "".join(speaker) == profile.local_joined) and (len(speaker) > 1 or len(speaker[0]) >= _MIN_PREFIX):
        return _Match(candidate, "medium", f"Email {candidate.email} matches the name")
    return _weak_match(speaker, profile)


def _weak_match(speaker: tuple[str, ...], profile: _Profile) -> _Match | None:
    candidate, name = profile.candidate, profile.name_tokens
    if not name:
        return None
    joined = "".join(speaker)
    spelled_as_initials = len(speaker) == 1 or all(len(word) == 1 for word in speaker)
    if len(name) > 1 and spelled_as_initials and joined == _initials(name):
        return _Match(candidate, "low", f"Initials match {_who(candidate)}")
    first = speaker[0]
    if len(speaker) > 1 and first == name[0] and len(name) > 1 and speaker[-1] == name[-1][0]:
        return _Match(candidate, "low", f"First name and last initial match {_who(candidate)}")
    if len(speaker) <= 2 and _nickname_of(first, name[0]) and (len(speaker) == 1 or (len(name) > 1 and speaker[-1] in {name[-1], name[-1][0]})):
        return _Match(candidate, "low", f"“{first.capitalize()}” is a short form of {_who(candidate)}")
    if len(speaker) == 1 and len(first) >= _MIN_PREFIX and name[0].startswith(first) and first != name[0]:
        return _Match(candidate, "low", f"Name is a short form of {_who(candidate)}")
    return None


def _best_level(matches: list[_Match]) -> list[_Match]:
    """Matches at the strongest confidence found; meeting people outrank the directory there."""
    if not matches:
        return []
    top = min(_CONFIDENCE_RANK[match.confidence] for match in matches)
    strongest = [match for match in matches if _CONFIDENCE_RANK[match.confidence] == top]
    meeting = [match for match in strongest if match.candidate.source in _MEETING_SOURCES]
    return meeting or strongest


def _alternatives(matches: list[_Match]) -> list[SuggestionAlternative]:
    return [SuggestionAlternative(email=match.candidate.email, display_name=match.candidate.display_name,
                                  source=match.candidate.source) for match in matches[:_MAX_ALTERNATIVES]]


def _ambiguous(speaker: str, matches: list[_Match], why: str) -> SpeakerSuggestion:
    return SpeakerSuggestion(speaker=speaker, status="ambiguous", reason=why, alternatives=_alternatives(matches))


def _suggest_one(speaker: str, profiles: list[_Profile]) -> SpeakerSuggestion | None:
    tokens = normalize_name(speaker)
    level = _best_level([match for profile in profiles if (match := _match(tokens, profile))])
    if not level:
        return None
    if len(level) > 1:
        names = ", ".join(match.candidate.display_name for match in level[:3])
        more = f" and {len(level) - 3} more" if len(level) > 3 else ""
        return _ambiguous(speaker, level, f"“{speaker}” matches {len(level)} people ({names}{more}); choose the right one")
    match = level[0]
    return SpeakerSuggestion(
        speaker=speaker, status="suggested", email=match.candidate.email,
        display_name=match.candidate.display_name, source=match.candidate.source,
        confidence=match.confidence, reason=match.reason,
    )


def _resolve_shared_emails(suggestions: list[SpeakerSuggestion]) -> list[SpeakerSuggestion]:
    """One email should not be proposed for two voices: the stronger match keeps it, a tie keeps neither."""
    by_email: dict[str, list[SpeakerSuggestion]] = {}
    for item in suggestions:
        if item.status == "suggested" and item.email:
            by_email.setdefault(item.email, []).append(item)
    replaced: dict[str, SpeakerSuggestion] = {}
    for email, items in by_email.items():
        if len(items) < 2:
            continue
        ranked = sorted(items, key=lambda item: _CONFIDENCE_RANK[item.confidence or "low"])
        best = _CONFIDENCE_RANK[ranked[0].confidence or "low"]
        winners = [item for item in ranked if _CONFIDENCE_RANK[item.confidence or "low"] == best]
        for item in ranked:
            if len(winners) == 1 and item is winners[0]:
                continue
            others = ", ".join(f"“{other.speaker}”" for other in items if other is not item)
            replaced[item.speaker] = SpeakerSuggestion(
                speaker=item.speaker, status="ambiguous",
                reason=f"{email} also matches speaker {others}; confirm who is who",
                alternatives=[SuggestionAlternative(email=email, display_name=item.display_name or email,
                                                    source=item.source or "invite")],
            )
    return [replaced.get(item.speaker, item) for item in suggestions]


def suggest_speaker_emails(
    speakers: Iterable[str], candidates: Iterable[Candidate], *,
    confirmed: dict[str, str], bot_name: str | None,
) -> list[SpeakerSuggestion]:
    """Advisory speaker→email suggestions for speakers who are named but not yet confirmed."""
    taken = {email.lower() for email in confirmed.values()}
    profiles = [_profile(candidate) for candidate in merge_candidates(candidates) if candidate.email not in taken]
    results: list[SpeakerSuggestion] = []
    for speaker in dict.fromkeys(speakers):
        if not speaker or speaker in confirmed or is_generic_speaker(speaker, bot_name):
            continue
        suggestion = _suggest_one(speaker, profiles)
        if suggestion:
            results.append(suggestion)
    return _resolve_shared_emails(results)
