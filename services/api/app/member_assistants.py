"""Members may schedule and control their own assistants, never a teammate's."""
import re
from sqlalchemy import select
from .database import CalendarScheduleRow, InPersonSessionRow, MeetingCoverageRow, MeetingTenantRow

_CREATE = {"/v1/meetings", "/v1/meetings/schedules", "/v1/calendar/meetings", "/v1/calendar/schedules", "/v1/call-coordination/check"}
_MEETING = re.compile(r"/v1/meetings/([0-9a-f-]{36})(?:/(join|stop|refresh|knowledge|delivery-settings|mom-guidance|transcription-route|post-meeting-job|participants))?")
_SCHEDULE = re.compile(r"/v1/calendar/schedules/([0-9a-f-]{36})(?:/(cancel))?")


def member_assistant_route(method, path, actor, database):
    if actor.role != "member":
        return False
    if method == "POST" and path in _CREATE:
        return True
    if method == "GET" and path == "/v1/calendar/schedules":
        return True
    match = _MEETING.fullmatch(path)
    if match:
        action = match.group(2)
        allowed = method == "GET" or method == "POST" and action in {"join", "stop", "refresh"} \
            or method == "PATCH" and action == "knowledge" \
            or method == "PUT" and action in {"delivery-settings", "mom-guidance"}
    else:
        match = _SCHEDULE.fullmatch(path)
        allowed = bool(match and (method == "GET" or method == "POST" and match.group(2) == "cancel"))
    if not match or not allowed:
        return False
    with database.session_factory() as session:
        tenant = session.get(MeetingTenantRow, match.group(1))
        if tenant is None or tenant.organization_id != str(actor.organization_id):
            return False
        if method == "POST" and session.get(InPersonSessionRow, match.group(1)) is not None:
            return False  # In-person recordings use their own recording controls, not Vexa joins/stops.
        owner = session.execute(select(MeetingCoverageRow.user_id).where(
            MeetingCoverageRow.meeting_id == match.group(1),
            MeetingCoverageRow.organization_id == str(actor.organization_id),
            MeetingCoverageRow.role == "owner",
            MeetingCoverageRow.decision.is_distinct_from("handed_over"),
        ).limit(1)).scalar_one_or_none()
        if owner is None:
            schedule = session.get(CalendarScheduleRow, match.group(1))
            owner = schedule.user_id if schedule and schedule.organization_id == str(actor.organization_id) else None
        return owner == str(actor.user_id)  # Unattributed legacy records are NOT member-owned.
