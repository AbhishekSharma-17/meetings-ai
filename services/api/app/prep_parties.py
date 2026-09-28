"""Who's who for meeting prep: which company is ours, which is the client, and who sits where.

Deterministic and offline. Our side is the organization identity (name, aliases, domains) plus
member email domains, the brief website and the contact email. The target (client) comes, in
priority order, from:

1. explicit prep inputs (target company / website),
2. external attendee email domains (never ours, free-mail, calendar/system/resource domains or
   noreply-style mailboxes),
3. a counterpart name parsed from the event title (or the agenda's first line) after removing
   our own name and aliases,
4. otherwise unknown.

A target that looks like us is dropped with a ``target_is_us`` warning, so a briefing never
researches our own company. Each attendee is classified as ours / theirs / other_external (a
third party such as another vendor) / unknown with a human-readable reason; organizer overrides
("mark as ours/theirs") win. Only theirs and other_external attendees are research subjects.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

Side = Literal["ours", "theirs", "other_external", "unknown"]
OverrideSide = Literal["ours", "theirs"]
WarningCode = Literal["target_is_us", "no_target", "identity_missing"]
RESEARCHABLE_SIDES = frozenset({"theirs", "other_external"})
MAX_ATTENDEES = 60
MAX_TITLE_CANDIDATE_WORDS = 6

FREE_MAIL_DOMAINS = frozenset({
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com",
    "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com",
    "yandex.com", "mail.com", "yahoo.co.in", "yahoo.co.uk", "rediffmail.com", "hey.com", "fastmail.com",
    "pm.me", "outlook.in", "hotmail.co.uk", "gmx.de", "web.de", "qq.com", "163.com",
})
# Calendar, conferencing and scheduling system hosts: never a person, never a client.
SYSTEM_DOMAIN_SUFFIXES = (
    "calendar.google.com", "calendar-notification.google.com", "calendar.zoom.us", "scheduler.zoom.us",
    "zoomcalendar.com", "reply.calendly.com", "teams.microsoft.com", "calendar.outlook.com",
)
_SYSTEM_LOCAL = re.compile(
    r"^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|mailer[-_.]?daemon|postmaster|"
    r"bounces?|calendar|calendly|scheduler|scheduling|invites?|invitations?|meetings?|zoom|teams|webinars?|"
    r"resource|rooms?|room[-_.].+|conf(?:erence)?[-_.]?room.*|booking|bookings)(?:[+].*)?$",
)
_ROOM_NAME = re.compile(r"\b(?:conference|meeting|board)\s*room\b|^room\s+\w+", re.I)
_LEGAL_SUFFIXES = frozenset({
    "inc", "incorporated", "llc", "llp", "ltd", "limited", "gmbh", "plc", "corp", "corporation", "co", "company",
    "pvt", "private", "sa", "ag", "bv", "nv", "srl", "the", "group", "holdings", "hq",
})
_SECOND_LEVEL = frozenset({"co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"})
_NOISE = frozenset("""
weekly daily monthly quarterly annual biweekly fortnightly sync synch syncup call calls meeting meetings meet
intro introduction introductions kickoff kick off catch up catchup demo review reviews discussion discuss follow
followup check in checkin standup 1 1on1 one on qbr mbr discovery partnership proposal workshop session sessions
chat touchbase touch base onboarding planning plan update updates status next steps pitch presentation roadmap
strategy alignment connect deep dive working team internal project prep debrief retro retrospective sprint
q1 q2 q3 q4 h1 h2 fy the a an for of about re fw fwd invitation updated new zoom teams google hangout webinar
interview lunch coffee dinner breakfast quick short first second final call exploratory quick sales
""".split())
_PREFIX = re.compile(
    r"^(?:(?:re|fw|fwd|invitation|updated invitation|accepted|declined|tentative|canceled|cancelled|reminder)"
    r"\s*:\s*)+", re.I)
_STRONG_SPLIT = re.compile(r"\s*(?:<=>|<->|<>|↔|⇄|\|\||\||//)\s*|\s+(?:x|×|vs\.?|versus)\s+", re.I)
_PAIR_SPLIT = re.compile(r"\s+(?:and|&|\+)\s+", re.I)
_WEAK_SPLIT = re.compile(r"\s*/\s*|\s+[-–—:]\s+|:\s+|\s+with\s+", re.I)

TARGET_IS_US_MESSAGE = "The target looked like your own company; add the client's name or website."
NO_TARGET_MESSAGE = "We couldn't tell which company you're meeting. Add the client's name or website."
IDENTITY_MISSING_MESSAGE = ("Add your company name and email domains in the Organization brief so briefings "
                            "never mix you up with the client.")


# ----- public shapes (API + stored in the report) ---------------------------------------------
class PartyCompany(BaseModel):
    name: str | None = None
    aliases: list[str] = Field(default_factory=list)
    domains: list[str] = Field(default_factory=list)
    website: str | None = None
    source: str = "none"  # identity | workspace | inputs | email_domain | event_title | none
    reason: str = ""


class PartyPerson(BaseModel):
    key: str
    name: str
    email: str | None = None
    side: Side = "unknown"
    reason: str = ""
    overridden: bool = False


class PartyWarning(BaseModel):
    code: WarningCode
    message: str


class WhosWho(BaseModel):
    our_company: PartyCompany = Field(default_factory=PartyCompany)
    target: PartyCompany = Field(default_factory=PartyCompany)
    attendees: list[PartyPerson] = Field(default_factory=list)
    ignored: list[str] = Field(default_factory=list)
    warnings: list[PartyWarning] = Field(default_factory=list)

    def people(self, *sides: str) -> list[PartyPerson]:
        return [person for person in self.attendees if person.side in sides]


# ----- our identity --------------------------------------------------------------------------
@dataclass(frozen=True)
class OurIdentity:
    """Everything that identifies our own company; used to keep us off the research list."""

    name: str | None = None
    aliases: tuple[str, ...] = ()
    domains: frozenset[str] = frozenset()
    name_source: str = "identity"  # identity | workspace | none
    configured: bool = False

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(item for item in (self.name, *self.aliases) if item)

    @property
    def keys(self) -> frozenset[str]:
        """Compact company keys: our names and aliases plus the root label of each of our domains."""
        keys = {key for item in self.names for key in company_keys(item)}
        keys.update(domain_root(domain) for domain in self.domains)
        return frozenset(key for key in keys if len(key) >= 2)

    def owns_domain(self, domain: str | None) -> bool:
        domain = (domain or "").lower().strip(".")
        return bool(domain) and any(domain == ours or domain.endswith(f".{ours}") for ours in self.domains)

    def is_us(self, text: str | None) -> bool:
        """Exact match on a name/alias (case, punctuation and legal-suffix insensitive) or one of our domains."""
        text = (text or "").strip()
        if not text:
            return False
        if _looks_like_host(text) and self.owns_domain(host_of(text)):
            return True
        return bool(company_keys(text) & self.keys)

    def mentioned_in(self, text: str | None) -> bool:
        """True when our name/alias appears as a word sequence inside ``text`` (e.g. a title fragment)."""
        if self.is_us(text):
            return True
        words = _words(text or "")
        roots = (domain_root(domain) for domain in self.domains)
        return any(_contains(words, _words(name)) for name in self.names if len(company_key(name)) >= 4) \
            or any(_contains(words, _words(root)) for root in roots if len(root) >= 4)


# ----- normalization helpers -----------------------------------------------------------------
def fold(value: str) -> str:
    return unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode().lower()


def _words(value: str) -> list[str]:
    return [word for word in re.split(r"[^a-z0-9]+", fold(value)) if word]


def company_keys(value: str | None) -> set[str]:
    """Compact spellings of a company name with trailing legal suffixes peeled off one at a time.

    'Our-Co Inc.' → {'ourcoinc', 'ourco', 'our'}; comparing key sets makes matching insensitive to
    case, punctuation, spacing and 'Inc/Ltd/Pvt Ltd' without breaking names that contain 'Co'.
    """
    words = _words(value or "")
    if words and words[0] == "the":
        words = words[1:]
    keys = {"".join(words)}
    while len(words) > 1 and words[-1] in _LEGAL_SUFFIXES:
        words = words[:-1]
        keys.add("".join(words))
    return {key for key in keys if len(key) >= 2}


def company_key(value: str | None) -> str:
    """'GenAI Protos, Inc.' → 'genaiprotos' (the most stripped spelling)."""
    keys = company_keys(value)
    return min(keys, key=len) if keys else ""


def domain_root(domain: str | None) -> str:
    labels = [label for label in (domain or "").lower().strip(".").split(".") if label]
    if len(labels) >= 3 and labels[-2] in _SECOND_LEVEL and len(labels[-1]) == 2:
        return labels[-3]
    return labels[-2] if len(labels) >= 2 else (labels[0] if labels else "")


def host_of(value: str | None) -> str | None:
    text = (value or "").strip().lower()
    if not text:
        return None
    if "@" in text and "://" not in text:
        text = text.rsplit("@", 1)[1]
    host = urlsplit(text if "://" in text else f"https://{text}").hostname
    return host.removeprefix("www.") if host else None


def email_domain(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    return email.rsplit("@", 1)[1].strip().lower().strip(".") or None


def _looks_like_host(text: str) -> bool:
    return "://" in text or ("." in text and " " not in text.strip())


def _contains(words: list[str], needle: list[str]) -> bool:
    size = len(needle)
    return bool(size) and any(words[index:index + size] == needle for index in range(len(words) - size + 1))


def is_free_mail(domain: str | None) -> bool:
    return bool(domain) and domain in FREE_MAIL_DOMAINS


def is_system_address(name: str | None, email: str | None) -> bool:
    """Calendar resources, groups, rooms and noreply/notification mailboxes are not people."""
    domain = email_domain(email)
    if domain and any(domain == suffix or domain.endswith(f".{suffix}") for suffix in SYSTEM_DOMAIN_SUFFIXES):
        return True
    local = email.split("@", 1)[0].strip().lower() if email and "@" in email else ""
    if local and _SYSTEM_LOCAL.match(local):
        return True
    return bool(name and _ROOM_NAME.search(name))


def attendee_key(name: str | None, email: str | None) -> str:
    if email and "@" in email:
        return email.strip().lower()
    return f"name:{' '.join(_words(name or '')) or 'guest'}"


# ----- title parsing -------------------------------------------------------------------------
def _clean_title(title: str) -> str:
    text = _PREFIX.sub("", (title or "").strip())
    text = re.sub(r"\s+@\s+.*$", "", text)  # Google's "Invitation: X @ Mon Oct 6, 2pm"
    text = re.sub(r"[\(\[\{][^\)\]\}]*[\)\]\}]", " ", text)
    return re.sub(r"\s+", " ", text).strip(" -–—:|")


def _strip_noise(part: str) -> str:
    tokens = [token.strip(".,;!?\"'()[]") for token in part.split()]
    kept = [token for token in tokens if token and fold(token) not in _NOISE and not re.fullmatch(r"[\d/.:-]+", token)]
    return " ".join(kept)


def _core(part: str) -> str:
    """The first meaningful fragment of a strongly separated part: 'Initech: pricing' → 'Initech'."""
    for piece in _WEAK_SPLIT.split(part):
        core = _strip_noise(piece or "")
        if core:
            return core
    return ""


def _plausible(candidate: str, *, capitalized: bool) -> bool:
    """A company-like fragment: short, and (for weak separators) written like a proper noun."""
    if not candidate or len(candidate.split()) > MAX_TITLE_CANDIDATE_WORDS or len(candidate) > 80:
        return False
    return not capitalized or candidate[0].isupper() or candidate[0].isdigit()


def counterpart_from_title(title: str | None, identity: OurIdentity, person_names: Iterable[str] = ()) -> str | None:
    """'GenAI Protos <> Acme weekly' → 'Acme'. Returns None unless a separator clearly pairs two sides."""
    text = _clean_title(title or "")
    if not text:
        return None
    people = {" ".join(_words(name)) for name in person_names if name} | \
             {(_words(name) or [""])[0] for name in person_names if name and len(_words(name)) > 1}
    for pattern, rule in ((_STRONG_SPLIT, "strong"), (_PAIR_SPLIT, "pair"), (_WEAK_SPLIT, "weak")):
        parts = [part.strip() for part in pattern.split(text) if part and part.strip()]
        if len(parts) < 2:
            continue
        cleaned = [(part, _core(part) if rule == "strong" else _strip_noise(part)) for part in parts]
        ours = [identity.mentioned_in(part) for part, _ in cleaned]
        candidates = [value for (_, value), mine in zip(cleaned, ours, strict=True)
                      if not mine and _plausible(value, capitalized=rule != "strong")
                      and " ".join(_words(value)) not in people]
        if not candidates:
            continue
        if rule == "strong":
            return candidates[0]
        others_ok = all(mine or not value or value == candidates[0]
                        for (_, value), mine in zip(cleaned, ours, strict=True))
        if len(candidates) == 1 and (any(ours) or (rule == "weak" and others_ok)):
            return candidates[0]
    return None


# ----- resolution ----------------------------------------------------------------------------
@dataclass(frozen=True)
class PartyInputs:
    target_company: str | None = None
    company_website: str | None = None
    overrides: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class _Person:
    key: str
    name: str
    email: str | None
    domain: str | None


def _collect(invitees: Iterable[Any]) -> tuple[list[_Person], list[str]]:
    people: dict[str, _Person] = {}
    ignored: list[str] = []
    for invitee in invitees:
        name = str(getattr(invitee, "name", "") or (invitee.get("name") if isinstance(invitee, dict) else "") or "").strip()
        email = getattr(invitee, "email", None) if not isinstance(invitee, dict) else invitee.get("email")
        email = str(email).strip() if email else None
        if is_system_address(name, email):
            ignored.append(email or name)
            continue
        key = attendee_key(name, email)
        if key not in people:
            local = email.split("@", 1)[0] if email and "@" in email else None
            people[key] = _Person(key=key, name=name or local or "Guest", email=email, domain=email_domain(email))
    return list(people.values())[:MAX_ATTENDEES], ignored[:20]


def _company_domain(person: _Person, identity: OurIdentity) -> str | None:
    """The external company domain a person's email reveals (None for ours, free-mail or no email)."""
    if not person.domain or is_free_mail(person.domain) or identity.owns_domain(person.domain):
        return None
    return person.domain


def _name_matches_domain(name: str | None, domain: str | None) -> bool:
    key, root = company_key(name), domain_root(domain)
    return len(root) >= 3 and bool(key) and (root in key or (len(key) >= 3 and key in root))


def _explicit_target(inputs: PartyInputs, identity: OurIdentity, warnings: list[PartyWarning]) -> tuple[str | None, str | None]:
    name = (inputs.target_company or "").strip() or None
    website = (inputs.company_website or "").strip() or None
    if name and identity.is_us(name):
        name = None
        _warn(warnings, "target_is_us", TARGET_IS_US_MESSAGE)
    if website and identity.is_us(website):
        website = None
        _warn(warnings, "target_is_us", TARGET_IS_US_MESSAGE)
    return name, website


def _warn(warnings: list[PartyWarning], code: WarningCode, message: str) -> None:
    if not any(item.code == code for item in warnings):
        warnings.append(PartyWarning(code=code, message=message))


def _domain_counts(people: list[_Person], identity: OurIdentity, overrides: Mapping[str, str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for person in people:
        side = overrides.get(person.key)
        domain = _company_domain(person, identity)
        if side == "ours" or not domain:
            continue
        counts[domain] = counts.get(domain, 0) + (10 if side == "theirs" else 1)
    return counts


def _resolve_target(inputs: PartyInputs, identity: OurIdentity, people: list[_Person], title: str | None,
                    agenda: str | None, warnings: list[PartyWarning]) -> PartyCompany:
    name, website = _explicit_target(inputs, identity, warnings)
    counts = _domain_counts(people, identity, inputs.overrides)
    ranked = [domain for domain, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))]
    names = [person.name for person in people]
    if name or website:
        domain = host_of(website) if website else None
        if domain is None and name:
            matched = [candidate for candidate in ranked if _name_matches_domain(name, candidate)]
            domain = matched[0] if matched else (ranked[0] if len(ranked) == 1 else None)
        if name is None and domain:
            titled = counterpart_from_title(title, identity, names)
            name = titled if _name_matches_domain(titled, domain) else None
        return PartyCompany(name=name, website=website, domains=[domain] if domain else [], source="inputs",
                            reason="Set in the prep inputs")
    if ranked:
        domain = ranked[0]
        titled = counterpart_from_title(title, identity, names)
        return PartyCompany(name=titled if _name_matches_domain(titled, domain) else None, website=f"https://{domain}",
                            domains=[domain], source="email_domain", reason=f"From email domain {domain}")
    for text, where in ((title, "event title"), (_first_line(agenda), "agenda")):
        titled = counterpart_from_title(text, identity, names)
        if titled and not identity.is_us(titled):
            return PartyCompany(name=titled, source="event_title", reason=f"From the {where}")
    _warn(warnings, "no_target", NO_TARGET_MESSAGE)
    return PartyCompany(source="none", reason="Not found in the inputs, attendee emails or title")


def _first_line(text: str | None) -> str | None:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()[:300]
    return None


def _classify(person: _Person, identity: OurIdentity, target: PartyCompany, overrides: Mapping[str, str]) -> PartyPerson:
    base = {"key": person.key, "name": person.name, "email": person.email}
    override = overrides.get(person.key)
    if override in {"ours", "theirs"}:
        label = "your team" if override == "ours" else "the client"
        return PartyPerson(**base, side=override, overridden=True, reason=f"You marked them as {label}")
    if identity.owns_domain(person.domain):
        return PartyPerson(**base, side="ours", reason=f"Email domain {person.domain} is yours")
    if not person.domain:
        return PartyPerson(**base, side="unknown", reason="No email address in the invite")
    if is_free_mail(person.domain):
        return PartyPerson(**base, side="unknown", reason=f"Personal email ({person.domain}); company unknown")
    target_domain = (target.domains or [None])[0]
    if target_domain and (person.domain == target_domain or person.domain.endswith(f".{target_domain}")):
        return PartyPerson(**base, side="theirs", reason=f"From email domain {person.domain}")
    if not target_domain and target.name and _name_matches_domain(target.name, person.domain):
        return PartyPerson(**base, side="theirs", reason=f"Email domain {person.domain} matches {target.name}")
    return PartyPerson(**base, side="other_external", reason=f"Another company ({person.domain})")


def resolve_parties(identity: OurIdentity, inputs: PartyInputs, invitees: Iterable[Any], *,
                    title: str | None = None, agenda: str | None = None) -> WhosWho:
    people, ignored = _collect(invitees)
    warnings: list[PartyWarning] = []
    target = _resolve_target(inputs, identity, people, title, agenda, warnings)
    attendees = [_classify(person, identity, target, inputs.overrides) for person in people]
    if not identity.configured and not identity.domains:
        _warn(warnings, "identity_missing", IDENTITY_MISSING_MESSAGE)
    our_company = PartyCompany(
        name=identity.name, aliases=list(identity.aliases), domains=sorted(identity.domains)[:20],
        source=identity.name_source,
        reason="From your Organization brief" if identity.configured else "From your workspace name and member emails",
    )
    return WhosWho(our_company=our_company, target=target, attendees=attendees, ignored=ignored, warnings=warnings)
