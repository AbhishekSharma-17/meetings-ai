"""Request and response shapes for the Research (Apollo Explorer) page.

Every request field is bounded (lengths, list sizes, enums) so nothing unbounded reaches Apollo, the
database or a prompt. Responses carry parsed Apollo facts only: never emails or phone numbers.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal
from urllib.parse import quote
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from .apollo_models import ApolloCompany, ApolloHiring, ApolloJob, ApolloNewsItem, ApolloPerson

ProfileKind = Literal["company", "person"]
RecordType = Literal["contact", "account"]  # what a person / company becomes in the team's Apollo CRM
APOLLO_APP_URL = "https://app.apollo.io/#"
PER_PAGE = 25
MAX_PAGE = 40
MAX_LIST = 10
MAX_LOOKUP = 25
MAX_QUESTION = 800

# Apollo's organization_num_employees_ranges values ("min,max"; open-ended "10001,").
EMPLOYEE_RANGES: dict[str, str] = {
    "1-10": "1,10", "11-50": "11,50", "51-200": "51,200", "201-500": "201,500", "501-1000": "501,1000",
    "1001-5000": "1001,5000", "5001-10000": "5001,10000", "10001+": "10001,",
}
EmployeeRange = Literal["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"]
# Apollo's person_seniorities values.
Seniority = Literal["owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager", "senior", "entry",
                    "intern"]
_DOMAIN = re.compile(r"^(?=.{3,200}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$")


def clean_domain(value: str) -> str:
    """'https://www.Acme.com/about' → 'acme.com'; anything that is not a plain host name is rejected."""
    text = value.strip().lower()
    text = re.sub(r"^[a-z]+://", "", text).split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    text = text.split("@")[-1].removeprefix("www.").strip(".")
    if not _DOMAIN.match(text):
        raise ValueError(f"“{value.strip()[:60]}” is not a website domain like acme.com")
    return text


def _clean_terms(values: list[str], limit: int = 80) -> list[str]:
    cleaned: list[str] = []
    for value in values:
        text = re.sub(r"\s+", " ", value).strip()
        if not text:
            continue
        if len(text) > limit:
            raise ValueError(f"each entry can be at most {limit} characters")
        if any(ord(character) < 32 for character in text):
            raise ValueError("entries cannot contain control characters")
        cleaned.append(text)
    return list(dict.fromkeys(cleaned))


class CompanySearchRequest(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    domains: list[str] = Field(default_factory=list, max_length=MAX_LIST)
    industry_keywords: list[str] = Field(default_factory=list, max_length=MAX_LIST)
    locations: list[str] = Field(default_factory=list, max_length=MAX_LIST)
    employee_ranges: list[EmployeeRange] = Field(default_factory=list, max_length=len(EMPLOYEE_RANGES))
    page: int = Field(default=1, ge=1, le=MAX_PAGE)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return (_clean_terms([value], 120) or [None])[0] if value else None

    @field_validator("domains")
    @classmethod
    def _domains(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(clean_domain(value) for value in values if value.strip()))

    @field_validator("industry_keywords", "locations")
    @classmethod
    def _terms(cls, values: list[str]) -> list[str]:
        return _clean_terms(values)

    def is_empty(self) -> bool:
        return not (self.name or self.domains or self.industry_keywords or self.locations or self.employee_ranges)


class PeopleSearchRequest(BaseModel):
    domains: list[str] = Field(default_factory=list, max_length=MAX_LIST)
    titles: list[str] = Field(default_factory=list, max_length=MAX_LIST)
    seniorities: list[Seniority] = Field(default_factory=list, max_length=11)
    locations: list[str] = Field(default_factory=list, max_length=MAX_LIST)
    keywords: str | None = Field(default=None, max_length=120)
    page: int = Field(default=1, ge=1, le=MAX_PAGE)

    @field_validator("domains")
    @classmethod
    def _domains(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(clean_domain(value) for value in values if value.strip()))

    @field_validator("titles", "locations")
    @classmethod
    def _terms(cls, values: list[str]) -> list[str]:
        return _clean_terms(values)

    @field_validator("keywords")
    @classmethod
    def _keywords(cls, value: str | None) -> str | None:
        return (_clean_terms([value], 120) or [None])[0] if value else None

    def is_empty(self) -> bool:
        return not (self.domains or self.titles or self.seniorities or self.locations or self.keywords)


class ApolloUsage(BaseModel):
    """Today's Apollo lookups by this person (UTC day) against the per-person daily cap."""

    used_today: int
    daily_limit: int


class CompanyHit(BaseModel):
    apollo_id: str | None = None
    name: str
    domain: str | None = None
    website: str | None = None
    linkedin_url: str | None = None
    logo_url: str | None = None
    industry: str | None = None
    employee_count: int | None = None
    headquarters: str | None = None
    in_apollo_account: bool = False
    saved_profile_id: UUID | None = None


class PersonHit(BaseModel):
    apollo_id: str
    name: str
    name_partial: bool = False  # Apollo hid part of the last name until the person is looked up
    title: str | None = None
    seniority: str | None = None
    company: str | None = None
    company_domain: str | None = None
    location: str | None = None
    linkedin_url: str | None = None
    in_apollo_contacts: bool = False
    saved_profile_id: UUID | None = None


class SearchPage(BaseModel):
    page: int
    per_page: int = PER_PAGE
    total: int | None = None
    total_pages: int | None = None
    cached: bool = False
    usage: ApolloUsage


class CompanySearchResponse(SearchPage):
    items: list[CompanyHit]


class PeopleSearchResponse(SearchPage):
    items: list[PersonHit]


class LookupRequest(BaseModel):
    apollo_ids: list[str] = Field(min_length=1, max_length=MAX_LOOKUP)
    confirm: bool = False
    refresh: bool = False

    @field_validator("apollo_ids")
    @classmethod
    def _ids(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value) for value in cleaned):
            raise ValueError("Apollo ids are letters, digits, dashes and underscores")
        return list(dict.fromkeys(cleaned))


class LookedUpPerson(BaseModel):
    apollo_id: str
    person: ApolloPerson | None
    company_domain: str | None = None


class LookupResponse(BaseModel):
    items: list[LookedUpPerson]
    usage: ApolloUsage


class SaveProfileRequest(BaseModel):
    kind: ProfileKind
    apollo_id: str | None = Field(default=None, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    domain: str | None = Field(default=None, max_length=200)
    name: str | None = Field(default=None, max_length=200)

    @field_validator("domain")
    @classmethod
    def _domain(cls, value: str | None) -> str | None:
        return clean_domain(value) if value and value.strip() else None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return (_clean_terms([value], 200) or [None])[0] if value else None


class JobGroup(BaseModel):
    """Open roles under one theme (Engineering, Sales…); ``count`` is Apollo's tally, ``jobs`` the examples we have."""

    theme: str
    count: int
    jobs: list[ApolloJob] = Field(default_factory=list)


class PersonRef(BaseModel):
    id: UUID | None = None
    name: str


def apollo_record_url(record_type: RecordType, record_id: str) -> str:
    """The Apollo web app page for a contact or account."""
    return f"{APOLLO_APP_URL}/{record_type}s/{quote(record_id, safe='')}"


class ApolloCrmLink(BaseModel):
    """Where a saved profile lives in the team's Apollo CRM, and who put it there ("Save to Apollo")."""

    record_type: RecordType
    record_id: str
    record_name: str | None = None
    action: Literal["created", "linked"]
    url: str
    by: PersonRef | None = None
    at: datetime


class ResearchProfilePublic(BaseModel):
    id: UUID
    kind: ProfileKind
    apollo_id: str | None
    domain: str | None
    name: str
    title: str | None = None
    company: str | None = None
    logo_url: str | None = None
    company_facts: ApolloCompany | None = None
    person: ApolloPerson | None = None
    news: list[ApolloNewsItem] = Field(default_factory=list)
    hiring: ApolloHiring | None = None
    job_groups: list[JobGroup] = Field(default_factory=list)
    created_by: PersonRef | None = None
    created_at: datetime
    updated_at: datetime
    fetched_at: datetime
    apollo_calls: int = 0
    can_delete: bool = False
    apollo_crm: ApolloCrmLink | None = None


class SaveProfileResponse(BaseModel):
    profile: ResearchProfilePublic
    created: bool
    usage: ApolloUsage


class ResearchStatus(BaseModel):
    connected: bool
    status: Literal["active", "invalid", "out_of_credit"] | None = None
    can_manage: bool
    can_use: bool
    usage: ApolloUsage | None = None
    bulk_confirm_over: int = 10
