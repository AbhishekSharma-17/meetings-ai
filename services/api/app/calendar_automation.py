"""Opt-in personal enrolment and durable, explicitly authorized recap delivery.

Discovery never joins a call itself. It creates ordinary calendar schedules, leaving
admission, calendar changes, capacity and departure to the existing services.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID, uuid4

from meetings_contracts import MeetingCreate, MeetingDeliverySettings, MinutesEmailRequest, MomGuidance
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError

from .accounts import Actor
from .call_keys import call_key_for_url
from .coordination_models import CallCheckRequest
from .composio_calendar import CalendarError, CalendarEvent
from .database import (
    AutomaticMinutesDeliveryRow, CalendarAutomationOccurrenceRow, CalendarAutomationRuleRow,
    CalendarScheduleRow, MeetingAutomationRow, OrganizationMembershipRow, OrganizationRow,
    RecipientGroupMemberRow, RecipientGroupRow, UserRow, WorkspaceAutomationPolicyRow,
)
from .repository import MeetingNotFoundError, MinutesNotFoundError
from .tenant import tenant_scope

logger = logging.getLogger(__name__)
LOOKAHEAD_DAYS = 14
MAX_SCHEDULES_PER_SCAN = 50


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=value.tzinfo or UTC).astimezone(UTC)


class AutomationSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    connection_ids: list[str] = Field(default_factory=list, max_length=20)
    meeting_types: Literal["all", "one_off", "recurring"] = "all"
    enrolment_scope: Literal["upcoming", "newly_discovered"] = "upcoming"
    bot_name: str = Field(default="Meetings AI", min_length=1, max_length=100)
    recording_disclosure_acknowledged: bool = False
    mom_mode: Literal["draft", "send_automatically"] = "draft"
    mom_guidance: MomGuidance = Field(default_factory=MomGuidance)
    delivery: MeetingDeliverySettings = Field(default_factory=MeetingDeliverySettings)
    knowledge_enabled: bool = False
    knowledge_base_id: UUID | None = None

    @field_validator("bot_name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("assistant name cannot be blank")
        return value

    @model_validator(mode="after")
    def coherent(self):
        self.connection_ids = list(dict.fromkeys(self.connection_ids))
        if self.enabled and (not self.connection_ids or not self.recording_disclosure_acknowledged):
            raise ValueError("select connected calendars and acknowledge meeting recording disclosure before enabling")
        if self.delivery.internal_recipients or self.delivery.participant_recipients or self.delivery.send_to_participants:
            raise ValueError("automatic delivery supports internal workspace teams only")
        if self.knowledge_enabled and self.knowledge_base_id is None:
            raise ValueError("choose a knowledge base before enabling knowledge indexing")
        return self


class AutomationPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    automatic_delivery_enabled: bool = False
    allowed_group_ids: list[UUID] = Field(default_factory=list, max_length=20)


class MeetingAutomationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skip: bool | None = None
    hold_delivery: bool | None = None
    mom_mode: Literal["inherit", "draft", "send_automatically"] | None = None
    internal_group_ids: list[UUID] | None = Field(default=None, max_length=20)
    knowledge_base_id: UUID | None = None


def occurrence_key(event: CalendarEvent) -> str:
    # Google/Outlook occurrence ids survive moves. Shared Zoom ids require the
    # provider's original start (or a conservatively reconciled current start).
    identity = event.event_id
    if event.series:
        original = event.original_starts_at or event.starts_at
        identity += "|" + utc(original).isoformat()
    return hashlib.sha256(identity.encode()).hexdigest()


def call_identity(event):
    identity = f"{call_key_for_url(event.meeting_url)}|{utc(event.starts_at).replace(second=0, microsecond=0).isoformat()}"
    return hashlib.sha256(identity.encode()).hexdigest()


def fingerprint(minutes) -> str:
    fields = ("title", "executive_summary", "discussion_points", "decisions", "action_items",
              "open_questions", "speaker_contributions", "questions_asked")
    values = {name: getattr(minutes, name) for name in fields}
    return hashlib.sha256(json.dumps(values, sort_keys=True, default=lambda x: x.model_dump()
                                    if hasattr(x, "model_dump") else vars(x)).encode()).hexdigest()


class CalendarAutomationService:
    def __init__(self, database, calendar, schedules, meetings, worker, minutes, knowledge_bases):
        self.database, self.calendar, self.schedules = database, calendar, schedules
        self.meetings, self.worker, self.minutes, self.knowledge_bases = meetings, worker, minutes, knowledge_bases
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._delivery_locks: dict[str, asyncio.Lock] = {}

    @property
    def enabled(self) -> bool:
        return os.getenv("AUTO_CALENDAR_SCHEDULE_ENABLED") == "1"

    @property
    def scan_seconds(self) -> int:
        try:
            return max(60, min(int(os.getenv("CALENDAR_AUTOMATION_SCAN_SECONDS", "300")), 3600))
        except ValueError:
            return 300

    def _actor(self, org: str, user: str) -> Actor | None:
        with self.database.session_factory() as session:
            membership = session.get(OrganizationMembershipRow, (org, user))
            person, workspace = session.get(UserRow, user), session.get(OrganizationRow, org)
            if not membership or not person or person.status != "active" or not workspace or workspace.status != "active":
                return None
            return Actor(UUID(user), UUID(org), person.email, person.display_name, membership.role, False, 0)

    def _rule(self, actor):
        with self.database.session_factory() as session:
            return session.get(CalendarAutomationRuleRow, (str(actor.organization_id), str(actor.user_id)))

    def policy(self, actor) -> dict:
        with self.database.session_factory() as session:
            row = session.get(WorkspaceAutomationPolicyRow, str(actor.organization_id))
            return {**(row.settings if row else AutomationPolicy().model_dump(mode="json")), "can_manage": actor.is_admin}

    def save_policy(self, actor, payload: AutomationPolicy):
        if not actor.is_admin:
            raise PermissionError("only workspace owners and admins can authorize automatic delivery")
        if payload.automatic_delivery_enabled:
            self._audience(actor, [str(item) for item in payload.allowed_group_ids], allow_empty=True)
        with self.database.session_factory.begin() as session:
            row = session.get(WorkspaceAutomationPolicyRow, str(actor.organization_id))
            if row is None:
                row = WorkspaceAutomationPolicyRow(organization_id=str(actor.organization_id))
                session.add(row)
            row.settings, row.authorized_by, row.updated_at = payload.model_dump(mode="json"), str(actor.user_id), datetime.now(UTC)
        return self.policy(actor)

    def get(self, actor) -> dict:
        row = self._rule(actor)
        settings = AutomationSettings.model_validate(row.settings) if row else AutomationSettings()
        policy = self.policy(actor)
        return {**settings.model_dump(mode="json"),
                "availability": {"calendar_configured": bool(self.calendar.configured), "scheduler_enabled": self.enabled,
                                 "auto_mom_enabled": os.getenv("AUTO_MOM_ENABLED") == "1"},
                "last_scan_at": row.last_scan_at if row else None,
                "next_scan_at": utc(row.last_scan_at) + timedelta(seconds=self.scan_seconds) if row and row.last_scan_at and settings.enabled else None,
                "last_error": row.last_error if row else None, "can_edit": actor.role != "viewer",
                "can_manage_policy": actor.is_admin, "can_auto_send": policy["automatic_delivery_enabled"]}

    def _validate(self, actor, settings):
        if actor.role == "viewer":
            raise PermissionError("viewers cannot configure assistant automation")
        if settings.knowledge_base_id:
            self.knowledge_bases.get(settings.knowledge_base_id, actor)
        if settings.mom_mode == "send_automatically":
            policy = self.policy(actor)
            groups = [str(item) for item in settings.delivery.internal_group_ids]
            if not policy["automatic_delivery_enabled"] or not groups or not set(groups) <= set(policy["allowed_group_ids"]):
                raise ValueError("automatic delivery requires workspace authorization and approved internal teams")
            self._audience(actor, groups)

    async def save(self, actor, settings: AutomationSettings):
        if actor.role == "viewer":
            raise PermissionError("viewers cannot configure assistant automation")
        if settings.enabled:
            self._validate(actor, settings)
        if settings.enabled:
            active = {item.id for item in await self.calendar.connections(actor) if item.status == "ACTIVE"}
            if not set(settings.connection_ids) <= active:
                raise ValueError("select active calendar connections belonging to your account")
        with self.database.session_factory.begin() as session:
            row = session.get(CalendarAutomationRuleRow, (str(actor.organization_id), str(actor.user_id)))
            if row is None:
                row = CalendarAutomationRuleRow(organization_id=str(actor.organization_id), user_id=str(actor.user_id), baselined_connections=[])
                session.add(row)
            previous = row.settings or {}
            reset = not previous.get("enabled") or previous.get("enrolment_scope") != settings.enrolment_scope
            row.baselined_connections = [] if reset else [item for item in row.baselined_connections if item in settings.connection_ids]
            row.settings, row.updated_at = settings.model_dump(mode="json"), datetime.now(UTC)
            row.last_error = None
        if not settings.enabled:
            self._cancel_pending(actor, "calendar automation disabled")
        else:
            self._cancel_pending(actor, "calendar connection removed from automation", excluded_connections=settings.connection_ids)
        return self.get(actor)

    def _cancel_pending(self, actor, reason, excluded_connections=None):
        with self.database.session_factory.begin() as session:
            ids = select(MeetingAutomationRow.meeting_id).where(MeetingAutomationRow.organization_id == str(actor.organization_id), MeetingAutomationRow.user_id == str(actor.user_id))
            query = update(CalendarScheduleRow).where(CalendarScheduleRow.meeting_id.in_(ids), CalendarScheduleRow.status == "pending")
            if excluded_connections is not None:
                query = query.where(CalendarScheduleRow.connection_id.not_in(excluded_connections))
            session.execute(query.values(status="cancelled", last_error=reason, updated_at=datetime.now(UTC)))
            if excluded_connections is None:
                session.execute(update(AutomaticMinutesDeliveryRow).where(AutomaticMinutesDeliveryRow.meeting_id.in_(ids), AutomaticMinutesDeliveryRow.status.not_in(["sent", "cancelled"])).values(status="cancelled", last_error=reason))
                session.execute(update(MeetingAutomationRow).where(MeetingAutomationRow.meeting_id.in_(ids)).values(suspended_reason=reason))
            else:
                removed = select(CalendarScheduleRow.meeting_id).where(CalendarScheduleRow.meeting_id.in_(ids), CalendarScheduleRow.connection_id.not_in(excluded_connections))
                session.execute(update(MeetingAutomationRow).where(MeetingAutomationRow.meeting_id.in_(removed)).values(suspended_reason=reason))
                session.execute(update(AutomaticMinutesDeliveryRow).where(AutomaticMinutesDeliveryRow.meeting_id.in_(removed), AutomaticMinutesDeliveryRow.status.not_in(["sent", "cancelled"])).values(status="cancelled", last_error=reason))

    async def _scans(self, actor, settings):
        active = {item.id for item in await self.calendar.connections(actor) if item.status == "ACTIVE"}
        now = datetime.now(UTC)
        result = []
        for connection in settings.connection_ids:
            if connection not in active:
                raise CalendarError("selected calendar connection is disconnected or no longer authorized")
            result.append((connection, await self.calendar.events_for_window(actor, connection, now, now + timedelta(days=LOOKAHEAD_DAYS), "UTC")))
        return result

    def _reason(self, actor, settings, event, *, baseline=False):
        if event.self_response_status and event.self_response_status.lower() in {"declined", "decline"}:
            return "invitation declined"
        if utc(event.starts_at) <= datetime.now(UTC) + timedelta(minutes=1):
            return "meeting has started or starts within one minute"
        if settings.meeting_types != "all" and event.is_recurring != (settings.meeting_types == "recurring"):
            return "meeting type excluded"
        with self.database.session_factory() as session:
            row = session.get(CalendarAutomationOccurrenceRow, (str(actor.organization_id), str(actor.user_id), event.connection_id, occurrence_key(event)))
            if row:
                return "already discovered: " + row.status
            if event.series and event.original_starts_at is None:
                schedules = session.execute(select(CalendarScheduleRow).where(
                    CalendarScheduleRow.organization_id == str(actor.organization_id),
                    CalendarScheduleRow.user_id == str(actor.user_id), CalendarScheduleRow.connection_id == event.connection_id,
                    CalendarScheduleRow.event_id == event.event_id)).scalars().all()
                if any(abs(utc(item.starts_at) - utc(event.starts_at)) <= timedelta(hours=12) for item in schedules):
                    return "shared series occurrence already scheduled"
        if baseline:
            return "existing occurrence at newly-discovered baseline"
        try:
            self.schedules._assert_not_imported(actor, event)
        except ValueError:
            return "an assistant already covers this call"
        check = self.schedules.coordination.check(actor, CallCheckRequest(meeting_url=event.meeting_url, starts_at=event.starts_at, ends_at=event.ends_at))
        if check.assistants or check.your_assistants:
            return "an assistant already covers this call"
        return None

    async def preview(self, actor, settings):
        self._validate(actor, settings)
        saved = self._rule(actor)
        baselined = saved.baselined_connections if saved and saved.settings.get("enabled") and saved.settings.get("enrolment_scope") == settings.enrolment_scope else []
        eligible, excluded, truncated = [], [], False
        for connection, scan in await self._scans(actor, settings):
            truncated |= scan.truncated
            baseline = settings.enrolment_scope == "newly_discovered" and connection not in baselined
            for event in scan.events:
                reason = self._reason(actor, settings, event, baseline=baseline)
                (excluded if reason else eligible).append({"event": event.model_dump(mode="json"), "reason": reason or "eligible"})
        return {"eligible": eligible, "excluded": excluded, "truncated": truncated}

    async def reconcile(self, actor):
        key = (str(actor.organization_id), str(actor.user_id))
        async with self._locks.setdefault(key, asyncio.Lock()):
            token, now = str(uuid4()), datetime.now(UTC)
            with self.database.session_factory.begin() as session:
                claimed = session.execute(update(CalendarAutomationRuleRow).where(
                    CalendarAutomationRuleRow.organization_id == key[0], CalendarAutomationRuleRow.user_id == key[1],
                    or_(CalendarAutomationRuleRow.lease_until.is_(None), CalendarAutomationRuleRow.lease_until <= now),
                ).values(lease_token=token, lease_until=now + timedelta(minutes=15))).rowcount
            if not claimed:
                return {"scheduled": 0, "excluded": 0, "errors": ["another calendar scan is already in progress"] if self._rule(actor) else []}
            try:
                return await self._reconcile(actor)
            finally:
                with self.database.session_factory.begin() as session:
                    session.execute(update(CalendarAutomationRuleRow).where(
                        CalendarAutomationRuleRow.organization_id == key[0], CalendarAutomationRuleRow.user_id == key[1], CalendarAutomationRuleRow.lease_token == token,
                    ).values(lease_token=None, lease_until=None))

    async def _reconcile(self, actor):
        row = self._rule(actor)
        result = {"scheduled": 0, "excluded": 0, "errors": []}
        if row is None or not row.settings.get("enabled"):
            return result
        if not self.enabled:
            raise ValueError("calendar scheduling is disabled on the server")
        actor = self._actor(str(actor.organization_id), str(actor.user_id))
        if actor is None or actor.role == "viewer":
            return result
        settings = AutomationSettings.model_validate(row.settings)
        try:
            scans = await self._scans(actor, settings)
            for connection, scan in scans:
                baseline = settings.enrolment_scope == "newly_discovered" and connection not in row.baselined_connections
                # Incomplete initial discovery cannot define what pre-existed activation.
                if baseline and scan.truncated:
                    result["errors"].append("initial scan was truncated; baseline deferred")
                    continue
                for event in sorted(scan.events, key=lambda item: utc(item.starts_at)):
                    if not baseline and result["scheduled"] >= MAX_SCHEDULES_PER_SCAN:
                        result["errors"].append("scan scheduling limit reached; remaining occurrences deferred")
                        break
                    fresh = self._rule(actor)
                    if not fresh or fresh.settings != row.settings or not fresh.settings.get("enabled"):
                        return result
                    reason = self._reason(actor, settings, event, baseline=baseline)
                    if reason in {"meeting type excluded", "invitation declined", "meeting has started or starts within one minute"} and not baseline:
                        result["excluded"] += 1
                        continue
                    identity = (str(actor.organization_id), str(actor.user_id), connection, occurrence_key(event))
                    try:
                        with self.database.session_factory.begin() as session:
                            session.add(CalendarAutomationOccurrenceRow(organization_id=identity[0], user_id=identity[1], connection_id=identity[2], occurrence_key=identity[3], call_identity=call_identity(event) if not reason else None, status="excluded" if reason else "claimed", reason=reason, created_at=datetime.now(UTC)))
                    except IntegrityError:
                        result["excluded"] += 1
                        continue
                    if reason:
                        result["excluded"] += 1
                        continue
                    try:
                        def attach(meeting):
                            with self.database.session_factory.begin() as session:
                                occurrence = session.get(CalendarAutomationOccurrenceRow, identity)
                                occurrence.meeting_id = str(meeting.id)
                                session.add(MeetingAutomationRow(meeting_id=str(meeting.id), organization_id=identity[0], user_id=identity[1], settings=settings.model_dump(mode="json"), overrides={}, created_at=datetime.now(UTC)))
                        with tenant_scope(actor.organization_id):
                            _, meeting = self.schedules.create_verified(actor, event, MeetingCreate(
                                meeting_url=event.meeting_url, bot_name=settings.bot_name,
                                mom_guidance=settings.mom_guidance, delivery_settings=settings.delivery,
                                knowledge_enabled=settings.knowledge_enabled, knowledge_base_id=settings.knowledge_base_id,
                            ), before_schedule=attach)
                        with self.database.session_factory.begin() as session:
                            occurrence = session.get(CalendarAutomationOccurrenceRow, identity)
                            occurrence.meeting_id, occurrence.status = str(meeting.id), "scheduled"
                        result["scheduled"] += 1
                    except Exception as exc:
                        with self.database.session_factory.begin() as session:
                            occurrence = session.get(CalendarAutomationOccurrenceRow, identity)
                            occurrence.status, occurrence.reason = "failed", str(exc)[:1000]
                        result["errors"].append(str(exc)[:1000])
                if baseline and not scan.truncated:
                    with self.database.session_factory.begin() as session:
                        current = session.get(CalendarAutomationRuleRow, (str(actor.organization_id), str(actor.user_id)))
                        if current.settings == row.settings:
                            current.baselined_connections = list(dict.fromkeys([*current.baselined_connections, connection]))
            error = "; ".join(result["errors"]) or None
        except Exception as exc:
            error = str(exc)[:1000]
            result["errors"].append(error)
        with self.database.session_factory.begin() as session:
            current = session.get(CalendarAutomationRuleRow, (str(actor.organization_id), str(actor.user_id)))
            current.last_scan_at, current.last_error = datetime.now(UTC), error
        return result

    async def allow_join(self, meeting_id):
        with self.database.session_factory() as session:
            state = session.get(MeetingAutomationRow, str(meeting_id))
            schedule = session.get(CalendarScheduleRow, str(meeting_id))
        if state is None:
            return True  # Explicit scheduling retains its existing semantics.
        actor = self._actor(state.organization_id, state.user_id)
        allowed = bool(actor and actor.role != "viewer" and not state.overrides.get("skip") and self.enabled)
        rule = self._rule(actor) if actor else None
        allowed &= bool(rule and rule.settings.get("enabled") and schedule and schedule.connection_id in rule.settings.get("connection_ids", []))
        if allowed:
            try:
                allowed = any(item.id == schedule.connection_id and item.status == "ACTIVE" for item in await self.calendar.connections(actor))
            except Exception:
                allowed = False
        # Calendar verification yields to other requests. Re-read the authorization
        # after it so a concurrent pause/removal cannot join using a stale rule.
        with self.database.session_factory() as session:
            fresh = session.get(MeetingAutomationRow, str(meeting_id))
            fresh_schedule = session.get(CalendarScheduleRow, str(meeting_id))
            fresh_rule = session.get(CalendarAutomationRuleRow, (state.organization_id, state.user_id))
            actor = self._actor(state.organization_id, state.user_id)
            allowed &= bool(actor and actor.role != "viewer" and fresh and not fresh.overrides.get("skip") and fresh_rule
                            and fresh_rule.settings.get("enabled") and fresh_rule.settings.get("recording_disclosure_acknowledged")
                            and fresh_schedule and fresh_schedule.status in {"pending", "joining"}
                            and fresh_schedule.connection_id in fresh_rule.settings.get("connection_ids", []))
        if not allowed:
            with self.database.session_factory.begin() as session:
                session.execute(update(CalendarScheduleRow).where(CalendarScheduleRow.meeting_id == str(meeting_id), CalendarScheduleRow.status.in_(["pending", "joining"])).values(status="cancelled", last_error="calendar automation authorization revoked or occurrence skipped", updated_at=datetime.now(UTC)))
        return allowed

    def meeting(self, actor, meeting_id):
        with self.database.session_factory() as session:
            state = session.get(MeetingAutomationRow, str(meeting_id))
            delivery = session.get(AutomaticMinutesDeliveryRow, str(meeting_id))
            if state and (state.organization_id != str(actor.organization_id) or (not actor.is_admin and state.user_id != str(actor.user_id))):
                raise MeetingNotFoundError("meeting not found")
            values = {"skip": False, "hold_delivery": False, "mom_mode": "inherit", "internal_group_ids": None, "knowledge_base_id": None}
            return {"automated": state is not None, "can_edit": bool(state and actor.role != "viewer"), **values, **(state.overrides if state else {}),
                    "delivery_status": delivery.status if delivery else None,
                    "last_error": (state.suspended_reason if state else None) or (delivery.last_error if delivery else None)}

    def patch_meeting(self, actor, meeting_id, payload):
        public = self.meeting(actor, meeting_id)
        if not public["can_edit"]:
            raise PermissionError("only the meeting owner or workspace admin can change automation")
        changes = payload.model_dump(mode="json", exclude_unset=True)
        for field in ("skip", "hold_delivery", "mom_mode"):
            if field in changes and changes[field] is None:
                raise ValueError(f"{field} cannot be null")
        if changes.get("internal_group_ids"):
            self._audience(actor, changes["internal_group_ids"])
        if "knowledge_base_id" in changes:
            base_id = payload.knowledge_base_id
            if base_id:
                self.knowledge_bases.get(base_id, actor)
            from meetings_contracts import MeetingKnowledgeUpdate
            with tenant_scope(actor.organization_id):
                meeting = self.meetings.repository.get_meeting(meeting_id)
                self.meetings.update_knowledge(meeting_id, MeetingKnowledgeUpdate(tags=meeting.tags, knowledge_enabled=bool(base_id), knowledge_base_id=base_id))
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingAutomationRow, str(meeting_id))
            row.overrides = {**row.overrides, **changes, "updated_by": str(actor.user_id)}
            if changes.get("skip"):
                session.execute(update(CalendarScheduleRow).where(CalendarScheduleRow.meeting_id == str(meeting_id), CalendarScheduleRow.status == "pending").values(status="cancelled", last_error="occurrence skipped by owner", updated_at=datetime.now(UTC)))
            delivery = session.get(AutomaticMinutesDeliveryRow, str(meeting_id))
            if delivery and delivery.status != "sent":
                if set(changes) == {"hold_delivery"}:
                    if changes["hold_delivery"]:
                        delivery.status, delivery.last_error = "held", "delivery held by owner"
                    elif delivery.last_error == "delivery held by owner":
                        delivery.status, delivery.last_error = "retry", None
                else:
                    delivery.status, delivery.last_error = "held", "automation settings changed; explicit review required"
        return self.meeting(actor, meeting_id)

    def suspend(self, meeting_id, reason):
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingAutomationRow, str(meeting_id))
            if row:
                row.suspended_reason = reason
            delivery = session.get(AutomaticMinutesDeliveryRow, str(meeting_id))
            if delivery and delivery.status != "sent":
                delivery.status, delivery.last_error = "held", reason

    def generated(self, meeting_id):
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingAutomationRow, str(meeting_id))
            if row and not row.suspended_reason:
                minutes = self.minutes.repository.get_minutes(meeting_id)
                row.generated_fingerprint = fingerprint(minutes)
                row.source_revision = self.minutes.repository.get_minutes_source_revision(meeting_id)

    def persist_generated(self, session, minutes, source_revision):
        """Called inside the MOM write transaction: content, source and provenance commit together."""
        row = session.get(MeetingAutomationRow, str(minutes.meeting_id))
        if row and not row.suspended_reason:
            row.generated_fingerprint, row.source_revision = fingerprint(minutes), source_revision

    def _audience(self, actor, group_ids, *, allow_empty=False):
        recipients, info = [], []
        with self.database.session_factory() as session:
            for group_id in group_ids:
                group = session.get(RecipientGroupRow, str(group_id))
                if not group or group.organization_id != str(actor.organization_id):
                    raise ValueError("automatic delivery team no longer exists in this workspace")
                members = session.execute(select(RecipientGroupMemberRow).where(RecipientGroupMemberRow.group_id == str(group_id))).scalars().all()
                addresses = []
                for member in members:
                    if not member.user_id:
                        raise ValueError("automatic delivery teams must contain workspace members only")
                    person = session.get(UserRow, member.user_id)
                    membership = session.get(OrganizationMembershipRow, (str(actor.organization_id), member.user_id))
                    if not membership or not person or person.status != "active" or not person.email:
                        raise ValueError("automatic delivery team contains a removed or inactive workspace member")
                    addresses.append(person.email.strip().lower())
                if not addresses and not allow_empty:
                    raise ValueError("automatic delivery team has no active recipients")
                recipients.extend(addresses)
                info.append({"id": str(group_id), "name": group.name, "member_count": len(addresses)})
        recipients = sorted(set(recipients))
        if len(recipients) > 50:
            raise ValueError("automatic delivery supports at most 50 recipients")
        if not recipients and not allow_empty:
            raise ValueError("automatic delivery has no recipients")
        return recipients, info

    def _before_email(self, state, frozen):
        """Final synchronous authorization check at the email adapter boundary."""
        with self.database.session_factory() as session:
            current = session.get(MeetingAutomationRow, state.meeting_id)
            intent = session.get(AutomaticMinutesDeliveryRow, state.meeting_id)
            schedule = session.get(CalendarScheduleRow, state.meeting_id)
        actor = self._actor(state.organization_id, state.user_id)
        if (not self.enabled or os.getenv("AUTO_MOM_ENABLED") != "1" or not actor or actor.role == "viewer" or not current
                or current.suspended_reason or current.overrides.get("skip") or current.overrides.get("hold_delivery")
                or not intent or intent.status in {"held", "cancelled", "sent"}):
            raise ValueError("automatic delivery authorization changed before sending")
        rule = self._rule(actor)
        if (not rule or not rule.settings.get("enabled") or not schedule
                or schedule.connection_id not in rule.settings.get("connection_ids", [])):
            raise ValueError("calendar automation authorization changed before sending")
        mode = current.overrides.get("mom_mode", "inherit")
        if (current.settings["mom_mode"] if mode == "inherit" else mode) != "send_automatically" or (mode == "inherit" and rule.settings.get("mom_mode") != "send_automatically"):
            raise ValueError("automatic delivery is no longer enabled for this meeting")
        groups = current.overrides.get("internal_group_ids")
        groups = groups if groups is not None else current.settings["delivery"]["internal_group_ids"]
        policy = self.policy(actor)
        if not policy["automatic_delivery_enabled"] or not groups or not set(groups) <= set(policy["allowed_group_ids"]):
            raise ValueError("workspace automatic delivery authorization changed before sending")
        recipients, info = self._audience(actor, groups)
        if recipients != frozen["recipients"] or info != frozen["groups"]:
            raise ValueError("team audience changed before sending")
        with self.database.session_factory() as session:
            if not self.schedules.coordination.owned_by(session, state.meeting_id, actor.user_id, actor.organization_id):
                raise ValueError("meeting ownership changed before sending")
        meeting_id = UUID(state.meeting_id)
        minutes = self.minutes.repository.get_minutes(meeting_id)
        if (minutes.status.value != "approved" or fingerprint(minutes) != current.generated_fingerprint
                or not minutes.approved_at or minutes.approved_at.isoformat() != frozen["approved_at"]
                or self.minutes.repository.get_transcript_revision(meeting_id) != current.source_revision):
            raise ValueError("MOM or transcript changed before sending")

    async def _deliver(self, state):
        if not self.enabled or os.getenv("AUTO_MOM_ENABLED") != "1":
            return
        meeting_id = UUID(state.meeting_id)
        with self.database.session_factory() as session:
            state = session.get(MeetingAutomationRow, state.meeting_id)
            if state is None:
                return
            delivery = session.get(AutomaticMinutesDeliveryRow, state.meeting_id)
        if delivery and delivery.status in {"sent", "held", "cancelled"}:
            return
        if delivery and delivery.attempts >= 5:
            self.suspend(meeting_id, "automatic send retry attempts exhausted; review delivery history")
            return
        if delivery and delivery.next_retry_at and utc(delivery.next_retry_at) > datetime.now(UTC):
            return
        actor = self._actor(state.organization_id, state.user_id)
        try:
            if not actor or actor.role == "viewer":
                raise ValueError("automation owner no longer has permission")
            with self.database.session_factory() as session:
                if not self.schedules.coordination.owned_by(session, state.meeting_id, actor.user_id, actor.organization_id):
                    raise ValueError("automation owner no longer owns this meeting")
            rule = self._rule(actor)
            if not rule or not rule.settings.get("enabled"):
                return
            with self.database.session_factory() as session:
                schedule = session.get(CalendarScheduleRow, state.meeting_id)
            if not schedule or schedule.connection_id not in rule.settings.get("connection_ids", []):
                raise ValueError("source calendar removed from automation")
            settings = AutomationSettings.model_validate(state.settings)
            mode = state.overrides.get("mom_mode", "inherit")
            if (settings.mom_mode if mode == "inherit" else mode) != "send_automatically":
                return
            if mode == "inherit" and rule.settings.get("mom_mode") != "send_automatically":
                return
            if state.suspended_reason or state.overrides.get("skip") or state.overrides.get("hold_delivery"):
                return
            meeting = self.meetings.repository.get_meeting(meeting_id)
            transcript = self.meetings.repository.get_transcript(meeting_id)
            # Drafting uses finalized turns only. A leftover provisional tail must
            # not strand an otherwise completed capture's valid automatic MOM.
            if (meeting.status.value != "completed" or not meeting.joined_at
                    or not any(segment.completed and segment.text.strip() for segment in transcript)):
                return
            try:
                minutes = self.minutes.repository.get_minutes(meeting_id)
            except MinutesNotFoundError:
                return
            if not state.generated_fingerprint:
                return  # Existing/manual drafts have no automatic-generation provenance.
            if fingerprint(minutes) != state.generated_fingerprint:
                raise ValueError("MOM content changed after automatic generation")
            if state.source_revision != self.minutes.repository.get_transcript_revision(meeting_id):
                raise ValueError("transcript changed after automatic MOM generation")
            if minutes.status.value == "sent":
                if delivery:
                    self._delivery_update(state.meeting_id, status="sent", completed_at=datetime.now(UTC))
                return
            if not settings.recording_disclosure_acknowledged:
                raise ValueError("meeting disclosure consent is missing")
            groups = state.overrides.get("internal_group_ids")
            groups = groups if groups is not None else [str(item) for item in settings.delivery.internal_group_ids]
            policy = self.policy(actor)
            if not policy["automatic_delivery_enabled"] or not groups or not set(groups) <= set(policy["allowed_group_ids"]):
                raise ValueError("workspace automatic delivery authorization was revoked")
            recipients, info = self._audience(actor, groups)
            if delivery:
                if delivery.frozen["recipients"] != recipients or delivery.frozen["groups"] != info:
                    raise ValueError("team membership changed after the audience was frozen")
                if datetime.now(UTC) > utc(delivery.created_at) + timedelta(hours=20):
                    raise ValueError("automatic send retry window expired; review delivery history")
                if minutes.approved_at and minutes.approved_at.isoformat() != delivery.frozen.get("approved_at"):
                    raise ValueError("MOM approval changed after the audience was frozen")
            else:
                # A generated draft is approved on behalf of the consenting owner. Approval is
                # persisted once: its timestamp is part of the email provider's idempotency key.
                if minutes.status.value != "draft":
                    raise ValueError("MOM was approved outside the automatic workflow")
                with self.database.session_factory() as session:
                    authorization = session.get(WorkspaceAutomationPolicyRow, state.organization_id)
                delivery = AutomaticMinutesDeliveryRow(meeting_id=state.meeting_id, organization_id=state.organization_id, authorized_by=authorization.authorized_by, status="pending", frozen={}, attempts=0, created_at=datetime.now(UTC))
                def freeze(session, approved):
                    delivery.frozen = {"recipients": recipients, "groups": info, "approved_at": approved.approved_at.isoformat(), "include_transcript": settings.delivery.include_transcript, "rule_owner_id": state.user_id, "override_authorized_by": state.overrides.get("updated_by")}
                    session.add(delivery)
                # Approval and frozen delivery intent share the MOM transaction. An
                # interruption leaves either a draft, or an approved, recoverable intent.
                minutes = self.minutes.approve(meeting_id, automated=True, on_save=freeze)
                from .operations import AuditService
                AuditService(self.database).append(actor, "automation.minutes.approved", "/v1/calendar/automation", 200, meeting_id)
            # Persist attempts before I/O; crashes retry the exact frozen audience and approval.
            self._delivery_update(state.meeting_id, status="sending", attempts=delivery.attempts + 1)
            try:
                await self.minutes.send(meeting_id, MinutesEmailRequest(recipients=delivery.frozen["recipients"], include_transcript=delivery.frozen["include_transcript"]), delivery.frozen["groups"], automated=True,
                                        on_attempt=lambda _delivery_id: self._before_email(state, delivery.frozen))
            except Exception as exc:
                if isinstance(exc, (ValueError, PermissionError)):
                    self.suspend(meeting_id, str(exc))
                    return
                attempts = delivery.attempts + 1
                self._delivery_update(state.meeting_id, status="held" if attempts >= 5 else "retry", last_error=str(exc)[:1000], next_retry_at=datetime.now(UTC) + timedelta(seconds=min(30 * 2 ** attempts, 600)))
            else:
                self._delivery_update(state.meeting_id, status="sent", completed_at=datetime.now(UTC), last_error=None, next_retry_at=None)
        except (ValueError, PermissionError) as exc:
            self.suspend(meeting_id, str(exc))

    def _delivery_update(self, meeting_id, **values):
        with self.database.session_factory.begin() as session:
            session.execute(update(AutomaticMinutesDeliveryRow).where(AutomaticMinutesDeliveryRow.meeting_id == str(meeting_id)).values(**values))

    async def tick(self):
        with self.database.session_factory() as session:
            rules = session.execute(select(CalendarAutomationRuleRow)).scalars().all()
            states = session.execute(select(MeetingAutomationRow)).scalars().all()
        for rule in rules:
            if not rule.settings.get("enabled"):
                continue
            actor = self._actor(rule.organization_id, rule.user_id)
            if actor and (not rule.last_scan_at or utc(rule.last_scan_at) + timedelta(seconds=self.scan_seconds) <= datetime.now(UTC)):
                try:
                    await self.reconcile(actor)
                except Exception:
                    logger.exception("calendar automation scan failed for one rule")
        for state in states:
            try:
                with tenant_scope(UUID(state.organization_id)):
                    async with self._delivery_locks.setdefault(state.meeting_id, asyncio.Lock()):
                        await self._deliver(state)
            except (MeetingNotFoundError, MinutesNotFoundError):
                continue
            except Exception:
                logger.exception("automatic recap reconciliation failed for %s", state.meeting_id)

    async def run(self):
        while True:
            try:
                await self.tick()
            except Exception:
                logger.exception("calendar automation reconciliation failed")
            await asyncio.sleep(20)
