"""Structured Apollo facts stored with a briefing (report v2 ``apollo`` block and attendee ``apollo``).

Everything here is built deterministically from Apollo responses (never by the LLM). Each block keeps
the ``source_id`` (``A1``, ``A2``…) of the Apollo source it came from so the UI can cite it. Contact
details (emails, phone numbers) are never kept.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

MatchedBy = Literal["email", "name"]


class ApolloCompany(BaseModel):
    apollo_id: str | None = None
    name: str | None = None
    domain: str | None = None
    website: str | None = None
    linkedin_url: str | None = None
    description: str | None = None
    industry: str | None = None
    employee_count: int | None = None
    revenue_band: str | None = None
    total_funding: str | None = None
    latest_funding_stage: str | None = None
    latest_funding_date: str | None = None
    latest_funding_amount: str | None = None
    headquarters: str | None = None
    founded_year: int | None = None
    tech_stack: list[str] = Field(default_factory=list)
    source_id: str | None = None


class ApolloRole(BaseModel):
    company: str | None = None
    title: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    current: bool = False


class ApolloPerson(BaseModel):
    name: str
    title: str | None = None
    seniority: str | None = None
    departments: list[str] = Field(default_factory=list)
    company: str | None = None
    role_started: str | None = None
    past_roles: list[ApolloRole] = Field(default_factory=list)
    linkedin_url: str | None = None
    location: str | None = None
    matched_by: MatchedBy = "email"
    source_id: str | None = None


class ApolloNewsItem(BaseModel):
    title: str
    url: str | None = None
    published_at: str | None = None
    snippet: str | None = None
    source_id: str | None = None


class ApolloJob(BaseModel):
    title: str
    url: str | None = None
    location: str | None = None
    posted_at: str | None = None


class HiringTheme(BaseModel):
    theme: str
    count: int


class ApolloHiring(BaseModel):
    open_roles: int = 0
    themes: list[HiringTheme] = Field(default_factory=list)
    examples: list[ApolloJob] = Field(default_factory=list)
    source_id: str | None = None


class ApolloContact(BaseModel):
    name: str
    title: str | None = None
    stage: str | None = None
    last_activity_at: str | None = None


class ApolloRelationship(BaseModel):
    account_name: str | None = None
    stage: str | None = None
    owner: str | None = None
    last_activity_at: str | None = None
    contacts: list[ApolloContact] = Field(default_factory=list)
    source_id: str | None = None


class ApolloSnapshot(BaseModel):
    """What Apollo added to one briefing (``notice`` explains a skipped or partial lookup)."""

    company: ApolloCompany | None = None
    people: list[ApolloPerson] = Field(default_factory=list)
    news: list[ApolloNewsItem] = Field(default_factory=list)
    hiring: ApolloHiring | None = None
    relationship: ApolloRelationship | None = None
    calls: int = 0
    cached_results: int = 0
    notice: str | None = None
    fetched_at: datetime | None = None


class CreditLine(BaseModel):
    """One Apollo credit type for the current billing cycle (``dialer`` is minutes, the rest credits)."""

    credit_type: str
    label: str
    used: float | None = None
    limit: float | None = None
    remaining: float | None = None
    unit: Literal["credits", "minutes"] = "credits"
