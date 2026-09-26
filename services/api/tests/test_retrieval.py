"""Hybrid chunk retrieval: ranking, tenant and scope isolation, live access checks (SQLite path)."""

import asyncio
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.accounts import Actor
from app.database import LEGACY_ORGANIZATION_ID, KnowledgeChunkRow, KnowledgeDocumentRow, OrganizationRow
from app.main import create_app
from document_fixtures import FakeProvider, calendar_event, configure_providers

OTHER_ORG = UUID("00000000-0000-4000-8000-00000000beef")


def _upload(client, scope, text, name, scope_id=None):
    response = client.post("/v1/documents", data={"scope": scope, **({"scope_id": scope_id} if scope_id else {})},
                           files={"file": (name, text, "text/markdown")})
    assert response.status_code == 201, response.text
    return response.json()


def _search(app, query, scopes, **kwargs):
    return asyncio.run(app.state.chunk_retriever.search(LEGACY_ORGANIZATION_ID, query, scopes=scopes, **kwargs))


def _member(user_id: UUID, role: str = "member") -> Actor:
    return Actor(user_id=user_id, organization_id=LEGACY_ORGANIZATION_ID, email=None, display_name="M",
                 role=role, must_change_password=False, session_version=0)


@pytest.fixture()
def indexed(tmp_path):
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'retrieval.db'}", credential_key="test-credential-key")
    fake = FakeProvider()
    with TestClient(app) as client:
        profile = configure_providers(client, app, fake)
        owner = UUID(client.get("/v1/auth/me").json()["user_id"])
        event_a = calendar_event(app, owner, LEGACY_ORGANIZATION_ID)
        event_b = calendar_event(app, owner, LEGACY_ORGANIZATION_ID)
        docs = {
            "pricing": _upload(client, "organization", b"# Pricing\n\nPilots start at a fixed fee per team.", "pricing.md"),
            "contract": _upload(client, "organization", b"# Legal\n\nThe master contract renews every year.", "legal.md"),
            "prep_a": _upload(client, "prep", b"# Notes\n\nAcme wants a pricing pilot next quarter.", "a.md", event_a),
            "prep_b": _upload(client, "prep", b"# Notes\n\nGlobex pricing discussion is confidential.", "b.md", event_b),
        }
        asyncio.run(app.state.indexing_worker.process_documents(limit=10))
        # A second workspace holds a near-identical chunk (same profile id string): it must never leak.
        with app.state.database.session_factory.begin() as session:
            if session.get(OrganizationRow, str(OTHER_ORG)) is None:
                session.add(OrganizationRow(id=str(OTHER_ORG), slug="other-org", display_name="Other", status="active", created_at=datetime.now(UTC), updated_at=datetime.now(UTC)))
            session.flush()
            session.add(KnowledgeChunkRow(
                id=str(uuid4()), organization_id=str(OTHER_ORG), scope="organization", scope_id=None,
                source_type="document", source_id="x", document_id=None, meeting_id=None, position=0,
                title="pricing.md", context="Pricing", content="Pilots start at a fixed fee per team.",
                token_count=10, details={}, fingerprint="f" * 64, profile_id=profile["id"], model="embed-test",
                dimensions=3, embedding=[1.0, 0.0, 0.1], created_at=datetime.now(UTC), embedded_at=datetime.now(UTC),
            ))
        yield app, client, docs, owner, event_a, event_b


def test_hybrid_ranking_prefers_semantic_and_lexical_agreement(indexed) -> None:
    app, _, docs, *_ = indexed
    results = _search(app, "What is the pilot fee?", [("organization", None)])
    assert results and results[0].document_id == docs["pricing"]["id"]
    top = results[0]
    assert top.scope == "organization" and top.source_type == "document" and top.score > 0
    assert top.details["retrieval"]["vector"] is not None and top.details["retrieval"]["lexical"] is not None
    assert top.context.startswith("LLM note") and "fixed fee" in top.content
    contract = _search(app, "contract renewal", [("organization", None)])
    assert contract[0].document_id == docs["contract"]["id"]


def test_tenant_and_scope_isolation(indexed) -> None:
    app, _, docs, _, event_a, event_b = indexed
    every = _search(app, "pricing fee pilot contract", [("organization", None)], limit=50)
    assert {item.document_id for item in every} == {docs["pricing"]["id"], docs["contract"]["id"]}
    assert all(item.source_id != "x" for item in every)
    prep_a = _search(app, "pricing", [("prep", event_a)])
    assert {item.document_id for item in prep_a} == {docs["prep_a"]["id"]}
    both = _search(app, "pricing", [("organization", None), ("prep", event_a)], limit=50)
    assert docs["prep_b"]["id"] not in {item.document_id for item in both}
    assert _search(app, "pricing", [("prep", event_b)], source_types=["mom"]) == []
    with pytest.raises(ValueError):
        _search(app, "pricing", [("prep", None)])
    other = asyncio.run(app.state.chunk_retriever.search(OTHER_ORG, "pricing fee", scopes=[("organization", None)]))
    assert [item.source_id for item in other] == ["x"]  # the other tenant sees only its own chunk


def test_live_access_checks_filter_results(indexed) -> None:
    app, _, docs, owner, event_a, _ = indexed
    stranger = _member(uuid4())
    assert _search(app, "pricing", [("prep", event_a)], actor=stranger) == []
    assert _search(app, "pricing", [("prep", event_a)], actor=_member(owner))
    with app.state.database.session_factory.begin() as session:
        session.delete(session.get(KnowledgeDocumentRow, docs["pricing"]["id"]))
    remaining = _search(app, "pilot fee", [("organization", None)], limit=50)
    assert docs["pricing"]["id"] not in {item.document_id for item in remaining}


def test_lexical_only_when_no_embedding_route(indexed) -> None:
    app, client, docs, *_ = indexed
    client.delete("/v1/provider-defaults/embeddings")
    app.state.chunk_retriever.store.embedding_route = lambda: None
    results = _search(app, "master contract", [("organization", None)])
    assert results[0].document_id == docs["contract"]["id"]
    assert results[0].details["retrieval"]["vector"] is None
    with app.state.database.session_factory() as session:
        assert session.execute(select(KnowledgeChunkRow.id)).first() is not None
