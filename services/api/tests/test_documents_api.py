"""Document ingestion endpoints: extraction, vision OCR, indexing, roles, limits and legacy routes."""

import asyncio

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.database import (
    LEGACY_ORGANIZATION_ID, KnowledgeChunkRow, KnowledgeDocumentRow,
    OrganizationBriefDocumentRow, UsageEventRow,
)
from app.main import create_app
from app.url_fetch import SafeFetcher
from document_fixtures import (
    FakeProvider, calendar_event, configure_providers, image_bytes, scanned_pdf, text_pdf,
)

MARKDOWN = (b"# Offer\n\n## Pricing\n\nPilots start at a fixed fee of 10k.\n\n"
            b"## Delivery\n\nWe deliver retrieval platforms in six weeks.")


def _app(tmp_path, name="docs.db"):
    return create_app(database_url=f"sqlite+pysqlite:///{tmp_path / name}", credential_key="test-credential-key")


def _index(app) -> None:
    asyncio.run(app.state.indexing_worker.process_documents())


def _upload(client, scope, data, filename, scope_id=None, content_type="application/octet-stream"):
    form = {"scope": scope, **({"scope_id": scope_id} if scope_id else {})}
    return client.post("/v1/documents", data=form, files={"file": (filename, data, content_type)})


def _usage(app, kind):
    with app.state.database.session_factory() as session:
        return session.execute(select(UsageEventRow).where(UsageEventRow.kind == kind)).scalars().all()


def test_markdown_upload_is_summarized_chunked_enriched_embedded_and_cached(tmp_path) -> None:
    app = _app(tmp_path)
    fake = FakeProvider()
    with TestClient(app) as client:
        configure_providers(client, app, fake)
        created = _upload(client, "organization", MARKDOWN, "offer.md", content_type="text/markdown")
        assert created.status_code == 201, created.text
        document = created.json()
        assert document["status"] == "pending" and document["chunk_count"] == 0
        assert document["content_type"] == "text/markdown" and document["ocr_page_count"] == 0
        _index(app)
        indexed = client.get(f"/v1/documents/{document['id']}").json()
        assert indexed["status"] == "indexed" and indexed["error"] is None
        assert indexed["summary"] == "A short test summary of the document."
        assert indexed["chunk_count"] >= 1 and "Pilots start" in indexed["text_preview"]
        with app.state.database.session_factory() as session:
            chunks = session.execute(select(KnowledgeChunkRow)).scalars().all()
        assert all(chunk.scope == "organization" and chunk.scope_id is None for chunk in chunks)
        assert all(chunk.context.startswith("LLM note") and chunk.details["context_source"] == "llm" for chunk in chunks)
        assert all(chunk.embedding and chunk.dimensions == 3 and chunk.model == "embed-test" for chunk in chunks)
        assert chunks[0].details["heading_path"][0] == "Offer"
        assert {event.purpose for event in _usage(app, "llm")} >= {"document_summary", "knowledge_enrichment"}
        assert _usage(app, "embedding")

        batches, embedded = len(fake.enrichment_batches), len(fake.embedded_texts)
        assert client.post(f"/v1/documents/{document['id']}/reindex").status_code == 202
        _index(app)
        assert len(fake.enrichment_batches) == batches, "unchanged chunks are never re-enriched"
        assert len(fake.embedded_texts) == embedded, "unchanged chunks keep their vectors"
        assert client.get(f"/v1/documents/{document['id']}").json()["status"] == "indexed"

        listed = client.get("/v1/documents", params={"scope": "organization"}).json()
        assert [item["id"] for item in listed] == [document["id"]]
        legacy = client.get("/v1/workspace/brief/documents").json()
        assert legacy[0]["id"] == document["id"] and set(legacy[0]) == {
            "id", "filename", "content_type", "character_count", "uploaded_at"}


def test_scanned_pages_and_images_go_through_the_owner_vision_model(tmp_path) -> None:
    app = _app(tmp_path)
    fake = FakeProvider()
    with TestClient(app) as client:
        configure_providers(client, app, fake, vision=True)
        scanned = _upload(client, "organization", scanned_pdf(), "contract.pdf")
        assert scanned.status_code == 201, scanned.text
        body = scanned.json()
        assert body["page_count"] == 1 and body["ocr_page_count"] == 1
        mixed = _upload(client, "organization", text_pdf(["Pricing for pilots is a fixed fee per team. " * 3, ""]),
                        "mixed.pdf").json()
        assert mixed["page_count"] == 2 and mixed["ocr_page_count"] == 1
        image = _upload(client, "organization", image_bytes("PNG"), "whiteboard.png", content_type="image/png").json()
        assert image["content_type"] == "image/png" and image["ocr_page_count"] == 1
        assert len(fake.vision_calls) == 3
        # The owner's vision model overrides the profile's text model for these calls only.
        assert all(call["model"]["text_generation"] == "vision-test" for call in fake.vision_calls)
        vision_events = _usage(app, "vision")
        assert len(vision_events) == 3 and {event.purpose for event in vision_events} == {"document_ocr"}
        assert all(event.input_tokens == 900 for event in vision_events)
        with app.state.database.session_factory() as session:
            text = session.get(KnowledgeDocumentRow, mixed["id"]).extracted_text
        pages = text.split("\f")
        assert "Pricing for pilots" in pages[0] and "Contract total is 42 EUR" in pages[1]


def test_without_vision_route_scanned_pages_are_marked_and_text_is_kept(tmp_path) -> None:
    app = _app(tmp_path)
    fake = FakeProvider()
    with TestClient(app) as client:
        configure_providers(client, app, fake, vision=False)
        mixed = _upload(client, "organization", text_pdf(["Pricing for pilots is a fixed fee per team. " * 3, ""]),
                        "mixed.pdf")
        assert mixed.status_code == 201 and mixed.json()["ocr_page_count"] == 0
        with app.state.database.session_factory() as session:
            text = session.get(KnowledgeDocumentRow, mixed.json()["id"]).extracted_text
        assert "OCR unavailable: no vision model is configured" in text.split("\f")[1]
        rejected = _upload(client, "organization", scanned_pdf(), "scan.pdf")
        assert rejected.status_code == 422 and "vision model" in rejected.json()["detail"]
        assert fake.vision_calls == [] and _usage(app, "vision") == []


def test_openrouter_default_is_used_for_vision_only_when_the_live_catalog_lists_image_input(tmp_path) -> None:
    app = _app(tmp_path)
    fake = FakeProvider()
    catalog = {"data": [
        {"id": "vendor/vision-lite", "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]}},
        {"id": "vendor/text-only", "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]}},
    ]}
    vision = app.state.document_service.vision
    vision.transport = httpx.MockTransport(lambda request: httpx.Response(200, json=catalog))
    with TestClient(app) as client:
        from meetings_contracts import ProviderType

        app.state.profile_service.adapters[ProviderType.OPENAI_COMPATIBLE] = fake
        for model, expected in (("vendor/vision-lite", True), ("vendor/text-only", False)):
            profile = client.post("/v1/provider-profiles", json={
                "name": f"Router {model[-4:]}", "provider_type": "openai_compatible", "execution_location": "cloud",
                "base_url": "https://openrouter.ai/api/v1", "api_key": "sk-or-test-key",
                "capabilities": [{"capability": "text_generation", "model": model}],
            }).json()
            assert client.put("/v1/provider-defaults/text_generation", json={
                "policy": "cloud_only", "cloud_profile_id": profile["id"],
            }).status_code == 200
            route = asyncio.run(vision.resolve(LEGACY_ORGANIZATION_ID))
            assert (route is not None) is expected
            if route:
                assert route.source == "workspace_default" and route.model == model and route.model_override is None


def test_limits_type_sniffing_and_scope_validation(tmp_path) -> None:
    app = _app(tmp_path)
    with TestClient(app) as client:
        app.state.document_service.max_bytes = 2000
        assert _upload(client, "organization", b"a" * 2001, "big.txt").status_code == 413
        assert _upload(client, "organization", b"", "empty.txt").status_code == 400
        assert _upload(client, "organization", b"\x00\x01binary" * 20, "x.pdf", content_type="application/pdf").status_code == 415
        assert _upload(client, "galaxy", b"hello world " * 5, "a.txt").status_code == 400
        assert _upload(client, "organization", b"hello world " * 5, "a.txt",
                       scope_id="7d9b8c7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e").status_code == 400
        assert _upload(client, "prep", b"hello world " * 5, "a.txt").status_code == 400
        assert _upload(client, "prep", b"hello world " * 5, "a.txt",
                       scope_id="7d9b8c7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e").status_code == 404
        # A spoofed image header cannot smuggle text past sniffing: bytes decide the type.
        spoofed = _upload(client, "organization", b"Plain words about pricing and delivery.", "photo.png",
                          content_type="image/png")
        assert spoofed.status_code == 201 and spoofed.json()["content_type"] == "text/plain"


def test_roles_per_scope(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "developer@genaiprotos.com")
    app = _app(tmp_path, "roles.db")

    def login(client, email, password):
        client.post("/v1/auth/logout")
        assert client.post("/v1/auth/login", json={"email": email, "password": password}).status_code == 200

    with TestClient(app) as client:
        login(client, "developer@genaiprotos.com", "owner-password-for-test")
        owner_id = client.get("/v1/auth/me").json()["user_id"]
        accounts = {}
        for role in ("member", "viewer"):
            invited = client.post("/v1/workspace/invite", json={
                "email": f"{role}@example.com", "display_name": f"Team {role}", "role": role,
            }).json()
            accounts[role] = invited["account"]["user_id"]
            login(client, f"{role}@example.com", invited["temporary_password"])
            assert client.post("/v1/auth/change-password", json={
                "current_password": invited["temporary_password"], "new_password": f"{role}-long-new-password",
            }).status_code == 200
            login(client, "developer@genaiprotos.com", "owner-password-for-test")
        org_doc = _upload(client, "organization", MARKDOWN, "offer.md").json()
        owner_base = client.post("/v1/knowledge-bases", json={"name": "Owner private"}).json()
        shared_base = client.post("/v1/knowledge-bases", json={"name": "Shared wiki"}).json()
        client.put(f"/v1/knowledge-bases/{shared_base['id']}/sharing", json={
            "visibility": "specific", "user_ids": [accounts["member"]]})
        owner_event = calendar_event(app, owner_id, LEGACY_ORGANIZATION_ID)
        member_event = calendar_event(app, accounts["member"], LEGACY_ORGANIZATION_ID)
        viewer_event = calendar_event(app, accounts["viewer"], LEGACY_ORGANIZATION_ID)

        login(client, "member@example.com", "member-long-new-password")
        text = b"Discovery notes about the client roadmap."
        assert _upload(client, "organization", text, "n.txt").status_code == 403
        assert client.get("/v1/documents", params={"scope": "organization"}).status_code == 200
        assert client.get(f"/v1/documents/{org_doc['id']}").status_code == 200
        assert client.delete(f"/v1/documents/{org_doc['id']}").status_code == 403
        assert client.post(f"/v1/documents/{org_doc['id']}/reindex").status_code == 403
        prep = _upload(client, "prep", text, "n.txt", scope_id=member_event)
        assert prep.status_code == 201, prep.text
        assert _upload(client, "prep", text, "n.txt", scope_id=owner_event).status_code == 404
        member_base = client.post("/v1/knowledge-bases", json={"name": "Member wiki"}).json()
        assert _upload(client, "knowledge_base", text, "n.txt", scope_id=member_base["id"]).status_code == 201
        assert _upload(client, "knowledge_base", text, "n.txt", scope_id=owner_base["id"]).status_code == 404
        assert _upload(client, "knowledge_base", text, "n.txt", scope_id=shared_base["id"]).status_code == 403
        assert client.get("/v1/documents", params={"scope": "knowledge_base", "scope_id": shared_base["id"]}).status_code == 200
        assert client.delete(f"/v1/documents/{prep.json()['id']}").status_code == 204

        login(client, "viewer@example.com", "viewer-long-new-password")
        assert _upload(client, "prep", text, "n.txt", scope_id=viewer_event).status_code == 403
        assert client.get("/v1/documents", params={"scope": "prep", "scope_id": viewer_event}).status_code == 403
        assert client.get("/v1/documents", params={"scope": "organization"}).status_code == 200


def test_embedding_outage_indexes_for_keywords_then_backfills_and_failures_retry(tmp_path) -> None:
    app = _app(tmp_path)
    fake = FakeProvider()
    worker = app.state.indexing_worker
    with TestClient(app) as client:
        configure_providers(client, app, fake)
        fake.fail_embeddings = True
        document = _upload(client, "organization", MARKDOWN, "offer.md").json()
        _index(app)
        indexed = client.get(f"/v1/documents/{document['id']}").json()
        assert indexed["status"] == "indexed" and indexed["error"].startswith("Indexed for keyword search only")
        fake.fail_embeddings = False
        assert asyncio.run(worker.backfill_embeddings()) >= 1
        with app.state.database.session_factory() as session:
            assert session.execute(select(func.count()).select_from(KnowledgeChunkRow).where(
                KnowledgeChunkRow.embedding.is_(None))).scalar_one() == 0

        second = _upload(client, "organization", b"Another note about delivery timelines.", "b.txt").json()

        async def broken(*args, **kwargs):
            raise RuntimeError("database hiccup")

        original = worker.store.sync
        worker.store.sync = broken
        for attempt in range(1, 6):
            worker._attempts[second["id"]] = (worker._attempts.get(second["id"], (0, 0))[0], 0.0)
            _index(app)
            status = client.get(f"/v1/documents/{second['id']}").json()
            assert status["status"] == ("failed" if attempt == 5 else "pending")
        assert "after 5 attempts" in status["error"]
        worker.store.sync = original
        assert client.post(f"/v1/documents/{second['id']}/reindex").status_code == 202
        _index(app)
        assert client.get(f"/v1/documents/{second['id']}").json()["status"] == "indexed"


def test_delete_removes_chunks_and_legacy_mirror_and_legacy_routes_delegate(tmp_path) -> None:
    app = _app(tmp_path)
    fake = FakeProvider()
    with TestClient(app) as client:
        configure_providers(client, app, fake)
        legacy = client.post("/v1/workspace/brief/documents",
                             files={"file": ("notes.md", MARKDOWN, "text/markdown")})
        assert legacy.status_code == 201 and set(legacy.json()) == {
            "id", "filename", "content_type", "character_count", "uploaded_at"}
        document_id = legacy.json()["id"]
        assert client.get(f"/v1/documents/{document_id}").json()["scope"] == "organization"
        _index(app)
        with app.state.database.session_factory() as session:
            assert session.get(OrganizationBriefDocumentRow, document_id) is not None
            assert session.execute(select(func.count()).select_from(KnowledgeChunkRow)).scalar_one() > 0
        assert client.delete(f"/v1/workspace/brief/documents/{document_id}").status_code == 204
        assert client.delete(f"/v1/workspace/brief/documents/{document_id}").status_code == 404
        assert client.get(f"/v1/documents/{document_id}").status_code == 404
        with app.state.database.session_factory() as session:
            assert session.get(OrganizationBriefDocumentRow, document_id) is None
            assert session.execute(select(func.count()).select_from(KnowledgeChunkRow)).scalar_one() == 0


def test_url_ingest_uses_the_ssrf_safe_fetcher(tmp_path) -> None:
    app = _app(tmp_path)

    async def resolver(host, port):
        return {"docs.example.com": ["93.184.216.34"], "internal.example.com": ["10.0.0.5"]}[host]

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "93.184.216.34" and request.headers["host"] == "docs.example.com"
        return httpx.Response(200, headers={"content-type": "text/html"},
                              content=b"<html><title>Pricing</title><body><h1>Plans</h1><p>Pilots cost 10k.</p></body></html>")

    with TestClient(app) as client:
        app.state.document_fetcher = SafeFetcher(resolver=resolver, transport=httpx.MockTransport(handler))
        fetched = client.post("/v1/documents/url", json={"scope": "organization", "url": "https://docs.example.com/pricing"})
        assert fetched.status_code == 201, fetched.text
        assert fetched.json()["source_url"] == "https://docs.example.com/pricing"
        assert fetched.json()["content_type"] == "text/html" and fetched.json()["filename"] == "docs.example.com-pricing.html"
        blocked = client.post("/v1/documents/url", json={"scope": "organization", "url": "https://internal.example.com/"})
        assert blocked.status_code == 400 and "private" in blocked.json()["detail"]


def test_organization_brief_is_indexed_once_per_change(tmp_path) -> None:
    app = _app(tmp_path)
    fake = FakeProvider()
    worker = app.state.indexing_worker
    with TestClient(app) as client:
        configure_providers(client, app, fake)
        assert client.put("/v1/workspace/brief", json={
            "overview": "We build retrieval platforms.", "services": ["RAG pilots"], "products": [],
        }).status_code == 200
        asyncio.run(worker.process_briefs())
        with app.state.database.session_factory() as session:
            rows = session.execute(select(KnowledgeChunkRow).where(KnowledgeChunkRow.source_type == "brief")).scalars().all()
            assert rows and rows[0].scope == "organization" and rows[0].source_id == str(LEGACY_ORGANIZATION_ID)
        brief = {"overview": "We build retrieval platforms.", "services": ["RAG pilots"], "products": [],
                 "website": None, "differentiators": "", "positioning": ""}
        assert asyncio.run(worker.index_brief(str(LEGACY_ORGANIZATION_ID), brief)) is False
        assert asyncio.run(worker.index_brief(str(LEGACY_ORGANIZATION_ID), {**brief, "services": ["Audits"]})) is True
