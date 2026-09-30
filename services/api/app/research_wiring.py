"""Wires the Research page (Apollo Explorer) into the app with one call from ``create_app``."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from .apollo_integration import ApolloIntegrationService
from .database import Database
from .research_actions import ResearchActions
from .research_chat import ResearchChat
from .research_crm import ApolloCrm
from .research_service import ResearchService
from .routes_research import register_research_routes


def install_research(
    app: FastAPI, *, database: Database, apollo: ApolloIntegrationService, usage: Any, repository: Any,
    meeting_prep: Any, documents: Any, providers: Any, ai_settings: Any, vault: Any, identities: Any,
) -> ResearchService:
    chat = ResearchChat(providers, ai_settings, vault, usage, repository)
    service = ResearchService(database=database, integration=apollo, usage=usage, repository=repository,
                              actions=ResearchActions(database, meeting_prep, documents), chat=chat, identities=identities)
    # "Save to Apollo" writes to the team's CRM; its outcomes are audited explicitly (see research_self_audited).
    service.crm = ApolloCrm(service.store, service.explorer, apollo.cache, getattr(app.state, "audit", None),
                            service.connected_account)
    register_research_routes(app, research=service)
    app.state.research = service
    return service
