"""Request/worker organization scope for application-owned data access."""

from contextlib import contextmanager
from contextvars import ContextVar
from uuid import UUID

from .database import LEGACY_ORGANIZATION_ID


_organization: ContextVar[UUID] = ContextVar("meetings_ai_organization", default=LEGACY_ORGANIZATION_ID)


def current_organization_id() -> UUID:
    return _organization.get()


@contextmanager
def tenant_scope(organization_id: UUID):
    token = _organization.set(organization_id)
    try:
        yield
    finally:
        _organization.reset(token)
