""""Save to Apollo": write a saved Research person as an Apollo contact, or a company as an Apollo account.

This changes the team's CRM, so it is deliberate at every step:

* Owners and admins only (members and viewers get 403 here and from the ``require_admin`` middleware).
* Always previewed: ``preview`` returns exactly the fields that will be written. Emails and phone numbers are
  never stored by Research, so they are never sent.
* Duplicates first: ``preview`` searches Apollo (``APOLLO_SEARCH_CONTACTS`` by name, kept when the company
  matches; ``APOLLO_SEARCH_ACCOUNTS`` by name, kept when the domain or name matches). A create refuses to run
  while a likely match exists unless the admin chose "Create anyway"; "Link to existing" writes nothing to
  Apollo and only records the Apollo id on the profile.
* Every Apollo call goes through the Research budget (kind ``apollo``, purpose ``research_save_to_apollo``,
  counted toward the person's daily cap), and every save or link (and failed attempt) is audited.

Composio tools and arguments (verified 2026-09-30 against https://docs.composio.dev/toolkits/apollo):
``APOLLO_SEARCH_CONTACTS`` {q_keywords, page, per_page}; ``APOLLO_SEARCH_ACCOUNTS`` {q_organization_name, page,
per_page}; ``APOLLO_LIST_CONTACT_STAGES`` / ``APOLLO_LIST_ACCOUNT_STAGES`` {}; ``APOLLO_LIST_USERS`` {page,
per_page}; ``APOLLO_CREATE_CONTACT`` {first_name*, last_name*, title, organization_name, account_id, website_url,
contact_stage_id} (no LinkedIn or owner field); ``APOLLO_CREATE_ACCOUNT`` {name*, domain, owner_id,
account_stage_id}. Responses follow Apollo's REST API (``contacts`` / ``accounts`` / ``contact_stages`` /
``account_stages`` / ``users`` lists; ``{"contact": {id}}`` / ``{"account": {id}}`` on create).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from .accounts import Actor
from .apollo_cache import ApolloCache, CacheKind
from .prep_parties import company_key
from .repository import ProfileNotFoundError
from .research_apollo import ExplorerApollo, ExplorerError
from .research_crm_models import (
    MAX_MATCHES,
    ApolloSavePreview,
    ApolloSaveRequest,
    CrmField,
    CrmMatch,
    CrmOption,
    account_candidates,
    contact_candidates,
    created_id,
    parse_options,
)
from .research_history import domain_matches, name_matches
from .research_models import RecordType, ResearchProfilePublic, apollo_record_url
from .research_store import ResearchStore

logger = logging.getLogger(__name__)

PURPOSE = "research_save_to_apollo"
SEARCH_PAGE = {"page": 1, "per_page": 25}
_OPTIONAL = {"plan", "error"}  # a stage/owner list Apollo won't share never blocks a save
_NEVER_SENT = "Emails and phone numbers: never stored in Research, so never sent."


class ApolloCrmError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message, self.status_code = message, status_code


def record_type_for(profile: ResearchProfilePublic) -> RecordType:
    return "contact" if profile.kind == "person" else "account"


def _noun(record_type: RecordType) -> str:
    return "contacts" if record_type == "contact" else "accounts"


def crm_error(exc: ExplorerError, record_type: RecordType, *, writing: bool) -> ApolloCrmError:
    """Apollo's refusals, said plainly; credit, key and budget problems keep the Research wording."""
    upstream = exc.error.upstream_status if exc.error is not None else None
    noun = _noun(record_type)
    if exc.code == "plan" or upstream == 403:
        verb = "creating" if writing else "searching"
        return ApolloCrmError(f"Your Apollo plan or key doesn't allow {verb} {noun}. An admin can check the key's "
                              "access in Apollo (saving needs a master API key).", 409)
    if upstream == 422 and writing:
        return ApolloCrmError(f"Apollo didn't accept these details. Your Apollo plan or key may not allow creating "
                              f"{noun}, or the chosen stage or owner no longer exists.", 409)
    return ApolloCrmError(exc.message, exc.status_code)


def split_name(name: str) -> tuple[str, str]:
    if "*" in name:
        raise ApolloCrmError("Apollo hid part of this person's name. Refresh the profile, then save it to Apollo.", 422)
    first, _, last = name.strip().rpartition(" ")
    if not first or not last:
        raise ApolloCrmError("Apollo needs a first and last name to create a contact.", 422)
    return first.strip(), last.strip()


class ApolloCrm:
    def __init__(self, store: ResearchStore, explorer: ExplorerApollo, cache: ApolloCache, audit: Any | None,
                 account_for: Callable[[Actor], str]) -> None:
        self.store, self.explorer, self.cache, self.audit = store, explorer, cache, audit
        self.account_for = account_for
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    # ----- preview -----------------------------------------------------------------------------
    async def preview(self, actor: Actor, profile_id: UUID) -> ApolloSavePreview:
        account, profile = self._begin(actor, profile_id)
        record_type = record_type_for(profile)
        _, fields, not_sent = self._payload(actor, profile, None, None)
        matches = await self._find_matches(actor, account, profile)
        stages, stages_note = await self._options(actor, account, f"{record_type}_stages", record_type)
        owners, owners_note = await self._options(actor, account, "users", record_type) \
            if record_type == "account" else ([], None)
        return ApolloSavePreview(record_type=record_type, fields=fields, not_sent=not_sent, matches=matches,
                                 stages=stages, stages_note=stages_note, owners=owners, owners_note=owners_note,
                                 usage=self.explorer.usage(actor))

    # ----- save --------------------------------------------------------------------------------
    async def save(self, actor: Actor, profile_id: UUID, request: ApolloSaveRequest) -> ResearchProfilePublic:
        try:
            account, _ = self._begin(actor, profile_id)
        except ApolloCrmError as exc:  # rejected before the lock (not an admin, not connected, already saved)
            self._audit_rejected(actor, profile_id, exc.status_code)
            raise
        lock = self._locks.setdefault((str(actor.organization_id), str(profile_id)), asyncio.Lock())
        async with lock:  # a double click can't create two records
            profile = self.store.public(actor, self.store.get_row(actor, profile_id))
            record_type = record_type_for(profile)
            try:
                if profile.apollo_crm is not None:
                    raise ApolloCrmError("This profile is already in Apollo.", 409)
                if request.action == "link":
                    return self._link(actor, profile, request.record_id)
                return await self._create(actor, account, profile, request)
            except ApolloCrmError as exc:
                self._audit(actor, f"research.apollo.{record_type}_save_failed", profile_id, exc.status_code)
                raise

    def _link(self, actor: Actor, profile: ResearchProfilePublic, record_id: str | None) -> ResearchProfilePublic:
        if not record_id:
            raise ApolloCrmError("Choose the Apollo record to link to.", 422)
        cached = self.cache.get(actor.organization_id, "crm_match", _match_key(profile))
        if cached is None:
            raise ApolloCrmError("The check for existing Apollo records has expired. Check Apollo again.", 409)
        match = next((item for item in cached.get("matches") or [] if item.get("id") == record_id), None)
        if match is None:
            raise ApolloCrmError("That record wasn't among the matches Apollo returned. Check Apollo again.", 422)
        return self._record(actor, profile, record_id, match.get("name"), "linked")

    async def _create(self, actor: Actor, account: str, profile: ResearchProfilePublic,
                      request: ApolloSaveRequest) -> ResearchProfilePublic:
        record_type = record_type_for(profile)
        cached = self.cache.get(actor.organization_id, "crm_match", _match_key(profile))
        matches = [CrmMatch.model_validate(item) for item in cached.get("matches") or []] if cached is not None \
            else await self._find_matches(actor, account, profile)
        if matches and not request.create_anyway:
            raise ApolloCrmError(f"Apollo already has a likely match for {profile.name}. Link to it, or choose "
                                 "Create anyway.", 409)
        await self._check_choice(actor, account, f"{record_type}_stages", request.stage_id, "stage", record_type)
        await self._check_choice(actor, account, "users", request.owner_id if record_type == "account" else None,
                                 "owner", record_type)
        arguments, _, _ = self._payload(actor, profile, request.stage_id, request.owner_id)
        try:
            data = await self.explorer.call(actor, account, f"create_{record_type}", arguments, purpose=PURPOSE)
        except ExplorerError as exc:
            raise crm_error(exc, record_type, writing=True) from None
        new_id = created_id(data, record_type)
        if new_id is None:
            logger.warning("Apollo create %s returned no id", record_type)
            raise ApolloCrmError("Apollo didn't confirm the new record. Check Apollo before trying again.", 502)
        return self._record(actor, profile, new_id, profile.name, "created")

    def _record(self, actor: Actor, profile: ResearchProfilePublic, record_id: str, name: str | None,
                action: str) -> ResearchProfilePublic:
        record_type = record_type_for(profile)
        row = self.store.set_crm(actor, profile.id, {
            "record_type": record_type, "record_id": record_id, "record_name": (name or "")[:200] or None,
            "action": action, "by": str(actor.user_id), "at": datetime.now(UTC).isoformat()})
        self._audit(actor, f"research.apollo.{record_type}_{action}", profile.id, 200)
        return self.store.public(actor, row)

    # ----- Apollo look-ups ---------------------------------------------------------------------
    async def _find_matches(self, actor: Actor, account: str, profile: ResearchProfilePublic) -> list[CrmMatch]:
        """Likely duplicates, always asked of Apollo live; remembered briefly for the admin's decision."""
        record_type = record_type_for(profile)
        kind, arguments = ("crm_contacts", {"q_keywords": profile.name, **SEARCH_PAGE}) if record_type == "contact" \
            else ("crm_accounts", {"q_organization_name": profile.name, **SEARCH_PAGE})
        try:
            data = await self.explorer.call(actor, account, kind, arguments, purpose=PURPOSE)
        except ExplorerError as exc:
            raise crm_error(exc, record_type, writing=False) from None
        matches = _contact_matches(profile, data) if record_type == "contact" else _account_matches(profile, data)
        self.cache.put(actor.organization_id, "crm_match", _match_key(profile),
                       {"matches": [item.model_dump() for item in matches]})
        return matches

    async def _options(self, actor: Actor, account: str, kind: CacheKind,
                       record_type: RecordType) -> tuple[list[CrmOption], str | None]:
        cached = self.cache.get(actor.organization_id, kind, "all")
        if cached is not None:
            return [CrmOption.model_validate(item) for item in cached.get("items") or []], None
        arguments = {"page": 1, "per_page": 100} if kind == "users" else {}
        try:
            data = await self.explorer.call(actor, account, kind, arguments, purpose=PURPOSE)
        except ExplorerError as exc:
            if exc.code not in _OPTIONAL:
                raise crm_error(exc, record_type, writing=False) from None
            label = "its users" if kind == "users" else "its stages"
            return [], f"Apollo didn't share {label} with this key, so none can be chosen."
        options = parse_options(data, "users") if kind == "users" else parse_options(data, kind)
        self.cache.put(actor.organization_id, kind, "all", {"items": [item.model_dump() for item in options]})
        return options, None

    async def _check_choice(self, actor: Actor, account: str, kind: CacheKind, value: str | None, label: str,
                            record_type: RecordType) -> None:
        """A stage or owner must be one Apollo listed; the list is fetched again when it has expired."""
        if value is None:
            return
        options, _ = await self._options(actor, account, kind, record_type)
        if value not in {option.id for option in options}:
            raise ApolloCrmError(f"Choose a {label} from Apollo's list.", 422)

    # ----- what gets written -------------------------------------------------------------------
    def _payload(self, actor: Actor, profile: ResearchProfilePublic, stage_id: str | None,
                 owner_id: str | None) -> tuple[dict[str, Any], list[CrmField], list[str]]:
        """(tool arguments, the fields shown to the admin, what is deliberately left out)."""
        if profile.kind == "person":
            return self._contact_payload(actor, profile, stage_id)
        arguments: dict[str, Any] = {"name": profile.name}
        fields = [CrmField(label="Account name", value=profile.name)]
        if profile.domain:
            arguments["domain"] = profile.domain
            fields.append(CrmField(label="Domain", value=profile.domain))
        if stage_id:
            arguments["account_stage_id"] = stage_id
        if owner_id:
            arguments["owner_id"] = owner_id
        linkedin = profile.company_facts.linkedin_url if profile.company_facts else None
        not_sent = ["Company LinkedIn page: Apollo's create-account tool has no field for it."] if linkedin else []
        return arguments, fields, [*not_sent, "Phone numbers: never stored in Research, so never sent."]

    def _contact_payload(self, actor: Actor, profile: ResearchProfilePublic,
                         stage_id: str | None) -> tuple[dict[str, Any], list[CrmField], list[str]]:
        first, last = split_name(profile.name)
        arguments: dict[str, Any] = {"first_name": first, "last_name": last}
        fields = [CrmField(label="First name", value=first), CrmField(label="Last name", value=last)]
        for key, label, value in (("title", "Title", profile.title), ("organization_name", "Company", profile.company),
                                  ("website_url", "Company website", profile.domain and f"https://{profile.domain}")):
            if value:
                arguments[key] = value
                fields.append(CrmField(label=label, value=value))
        linked = self.store.company_account(actor, profile.domain)
        if linked is not None:
            arguments["account_id"] = linked[0]
            fields.append(CrmField(label="Apollo account", value=linked[1]))
        if stage_id:
            arguments["contact_stage_id"] = stage_id
        linkedin = profile.person.linkedin_url if profile.person else None
        not_sent = ["LinkedIn profile: Apollo's create-contact tool has no field for it."] if linkedin else []
        return arguments, fields, [*not_sent, _NEVER_SENT]

    # ----- plumbing ----------------------------------------------------------------------------
    def _begin(self, actor: Actor, profile_id: UUID) -> tuple[str, ResearchProfilePublic]:
        if not actor.is_admin:
            raise ApolloCrmError("Only owners and admins can save to Apollo. Ask an admin.", 403)
        account = self.account_for(actor)
        profile = self.store.public(actor, self.store.get_row(actor, profile_id))
        if profile.apollo_crm is not None:
            raise ApolloCrmError("This profile is already in Apollo.", 409)
        return account, profile

    def _audit_rejected(self, actor: Actor, profile_id: UUID, status_code: int) -> None:
        try:
            record_type = record_type_for(self.store.public(actor, self.store.get_row(actor, profile_id)))
        except ProfileNotFoundError:
            return  # nothing in this workspace to attribute the attempt to; the 404 says so
        self._audit(actor, f"research.apollo.{record_type}_save_failed", profile_id, status_code)

    def _audit(self, actor: Actor, action: str, profile_id: UUID, status_code: int) -> None:
        if self.audit is None:
            return
        try:
            self.audit.append(actor, action, f"/v1/research/profiles/{profile_id}/apollo", status_code, profile_id)
        except Exception:
            logger.exception("could not record the Save to Apollo audit event")


def _match_key(profile: ResearchProfilePublic) -> str:
    return f"{record_type_for(profile)}:{profile.id}"


def _contact_matches(profile: ResearchProfilePublic, data: dict[str, Any]) -> list[CrmMatch]:
    """Same first and last name, and (when both are known) the same company."""
    wanted = company_key(profile.company)
    matches = []
    for item in contact_candidates(data):
        company = item.get("company")
        if not name_matches(profile.name, item["name"]) or (wanted and company and company_key(company) != wanted):
            continue
        detail = " at ".join(part for part in (item.get("title"), company) if part) or None
        matches.append(CrmMatch(id=item["id"], name=item["name"], detail=detail,
                                url=apollo_record_url("contact", item["id"])))
    return matches[:MAX_MATCHES]


def _account_matches(profile: ResearchProfilePublic, data: dict[str, Any]) -> list[CrmMatch]:
    """The same domain, or the same company name once legal suffixes and punctuation are ignored."""
    wanted = company_key(profile.name)
    matches = []
    for item in account_candidates(data):
        same_domain = bool(profile.domain and item.get("domain")) and (
            domain_matches(item["domain"], profile.domain) or domain_matches(profile.domain, item["domain"]))
        if not same_domain and not (wanted and company_key(item["name"]) == wanted):
            continue
        matches.append(CrmMatch(id=item["id"], name=item["name"], detail=item.get("domain"),
                                url=apollo_record_url("account", item["id"])))
    return matches[:MAX_MATCHES]
