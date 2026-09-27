"""Which workspace a new session lands in.

Order: the user's chosen default, else the workspace active last time, else
the oldest membership. Every candidate is re-checked against a live, active
membership, so a removed or archived workspace is never selected.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .database import OrganizationMembershipRow, OrganizationRow, UserWorkspacePreferenceRow


def _is_active_member(session: Session, user_id: str, organization_id: str | None) -> bool:
    if not organization_id:
        return False
    return session.execute(
        select(OrganizationMembershipRow.organization_id)
        .join(OrganizationRow, OrganizationRow.id == OrganizationMembershipRow.organization_id)
        .where(
            OrganizationMembershipRow.user_id == user_id,
            OrganizationMembershipRow.organization_id == organization_id,
            OrganizationRow.status == "active",
        )
    ).scalar_one_or_none() is not None


def preferred_organization_id(session: Session, user_id: str) -> str | None:
    """Default if still valid, else last active if still valid, else None (caller falls back)."""
    preference = session.get(UserWorkspacePreferenceRow, user_id)
    if preference is None:
        return None
    for candidate in (preference.default_organization_id, preference.last_organization_id):
        if _is_active_member(session, user_id, candidate):
            return candidate
    return None


def default_organization_id(session: Session, user_id: str) -> str | None:
    """The stored default, only while it still points at an active membership."""
    preference = session.get(UserWorkspacePreferenceRow, user_id)
    if preference is None or not _is_active_member(session, user_id, preference.default_organization_id):
        return None
    return preference.default_organization_id


def _row(session: Session, user_id: str) -> UserWorkspacePreferenceRow:
    preference = session.get(UserWorkspacePreferenceRow, user_id)
    if preference is None:
        preference = UserWorkspacePreferenceRow(
            user_id=user_id, default_organization_id=None, last_organization_id=None,
            updated_at=datetime.now(UTC),
        )
        session.add(preference)
    return preference


def record_last_organization(session: Session, user_id: str, organization_id: str) -> None:
    preference = _row(session, user_id)
    if preference.last_organization_id != organization_id:
        preference.last_organization_id = organization_id
        preference.updated_at = datetime.now(UTC)


def set_default_organization(session: Session, user_id: str, organization_id: str | None) -> None:
    """Caller must already have verified membership when organization_id is set."""
    preference = _row(session, user_id)
    preference.default_organization_id = organization_id
    preference.updated_at = datetime.now(UTC)


def forget_organization(session: Session, user_id: str, organization_id: str) -> None:
    """Drop a workspace from the user's preferences when their membership ends."""
    now = datetime.now(UTC)
    session.execute(
        update(UserWorkspacePreferenceRow)
        .where(UserWorkspacePreferenceRow.user_id == user_id,
               UserWorkspacePreferenceRow.default_organization_id == organization_id)
        .values(default_organization_id=None, updated_at=now)
    )
    session.execute(
        update(UserWorkspacePreferenceRow)
        .where(UserWorkspacePreferenceRow.user_id == user_id,
               UserWorkspacePreferenceRow.last_organization_id == organization_id)
        .values(last_organization_id=None, updated_at=now)
    )
