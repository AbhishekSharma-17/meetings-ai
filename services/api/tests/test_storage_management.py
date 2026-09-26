"""Per-workspace storage accounting and category purges (tenant-scoped, audited, idempotent)."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from app.adapters.vexa import VexaCaptureAdapter
from app.database import (
    LEGACY_ADMIN_USER_ID, LEGACY_ORGANIZATION_ID, AuditEventRow, CalendarEventCacheRow, CalendarSyncStateRow,
    KnowledgeBaseRow, KnowledgeChunkRow, KnowledgeConversationRow, KnowledgeDocumentRow, KnowledgeEmbeddingRow,
    KnowledgeIndexJobRow, KnowledgeMessageRow, MeetingPrepInputRow, MeetingPrepRow, MeetingRow, MeetingTenantRow,
    OrganizationBriefDocumentRow, OrganizationRow, TranscriptSegmentRow, UsageEventRow,
)
from app.main import create_app

OTHER_ORG = UUID("00000000-0000-4000-8000-0000000000aa")


class FakeVexa:
    def __init__(self) -> None:
        self.deleted: list[int] = []
        self.recordings = {42: [{"id": 1, "media_files": [{"file_size_bytes": 1000}, {"file_size_bytes": 500}]}]}

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE" and request.url.path.startswith("/meetings/"):
            self.deleted.append(int(request.url.path.rsplit("/", 1)[1]))
            return httpx.Response(204)
        if request.method == "GET" and request.url.path == "/recordings":
            capture = int(request.url.params["meeting_id"])
            if capture == 99:
                return httpx.Response(503, json={"detail": "down"})
            return httpx.Response(200, json={"recordings": self.recordings.get(capture, []), "total": 1})
        raise AssertionError(f"unexpected Vexa call {request.method} {request.url}")


def _app(tmp_path, fake: FakeVexa):
    adapter = VexaCaptureAdapter("http://vexa.test", "key", transport=httpx.MockTransport(fake.handler))
    return create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'storage.db'}",
                      credential_key="test-credential-key", vexa_adapter=adapter)


def _seed(app, org: UUID, *, capture_id: int | None = 42, status: str = "completed") -> dict[str, str]:
    """Insert one of everything for a workspace directly, so every category has bytes."""
    now = datetime.now(UTC)
    ids = {key: str(uuid4()) for key in (
        "meeting", "base", "conversation", "event", "org_doc", "kb_doc", "prep_doc", "brief_doc")}
    org_id, user = str(org), str(LEGACY_ADMIN_USER_ID)
    with app.state.database.session_factory.begin() as session:
        if session.get(OrganizationRow, org_id) is None:
            session.add(OrganizationRow(id=org_id, slug=f"org-{org_id[:8]}", display_name="Other", contact_email=None,
                                        status="active", created_at=now, updated_at=now))
        session.add(MeetingRow(id=ids["meeting"], meeting_url="https://meet.google.com/abc-defg-hij",
                               title=f"Board review {org_id[-2:]}", bot_name="Bot", language=None,
                               transcribe_enabled=True, recording_enabled=True, platform="google_meet",
                               native_meeting_id="abc-defg-hij", status=status, vexa_meeting_id=capture_id,
                               last_error=None, created_at=now - timedelta(days=40), updated_at=now))
        session.flush()  # PostgreSQL enforces the foreign keys below.
        session.add(MeetingTenantRow(meeting_id=ids["meeting"], organization_id=org_id))
        session.add_all(TranscriptSegmentRow(meeting_id=ids["meeting"], position=index, start_seconds=index,
                                             end_seconds=index + 1, text="spoken words " * 40, speaker="A",
                                             language="en", completed=True) for index in range(20))
        session.add(KnowledgeBaseRow(id=ids["base"], organization_id=org_id, name=f"Wiki {ids['base'][:8]}",
                                     description=None, created_by=user, visibility="organization",
                                     text_profile_id=None, created_at=now, updated_at=now))
        session.flush()
        session.add(KnowledgeConversationRow(id=ids["conversation"], knowledge_base_id=ids["base"], user_id=user,
                                             title="Old chat", created_at=now - timedelta(days=90),
                                             updated_at=now - timedelta(days=90)))
        session.flush()
        session.add(KnowledgeMessageRow(id=str(uuid4()), conversation_id=ids["conversation"], position=0,
                                        role="user", content="question " * 50, citations=[], provider=None,
                                        model=None, created_at=now))
        session.add(CalendarEventCacheRow(id=ids["event"], organization_id=org_id, user_id=user, connection_id="conn-1",
                                          provider="googlecalendar", event_id=f"evt-{ids['event']}", starts_at=now,
                                          ends_at=now, payload={"title": "Acme prep"}, synced_at=now))
        session.add(CalendarEventCacheRow(id=str(uuid4()), organization_id=org_id, user_id=user, connection_id="conn-1",
                                          provider="googlecalendar", event_id=f"old-{ids['event']}", starts_at=now,
                                          ends_at=now - timedelta(days=60), payload={"title": "Old"}, synced_at=now))
        session.flush()
        if session.get(CalendarSyncStateRow, (org_id, user, "conn-1")) is None:
            session.add(CalendarSyncStateRow(organization_id=org_id, user_id=user, connection_id="conn-1",
                                             last_synced_at=now, range_start=now, range_end=now, truncated=False))
        session.add(MeetingPrepRow(id=str(uuid4()), organization_id=org_id, user_id=user, calendar_event_id=ids["event"],
                                   context="ctx", profile_urls=[], report={"brief": "x" * 500}, created_at=now))
        session.add(MeetingPrepInputRow(calendar_event_id=ids["event"], organization_id=org_id, target_company="Acme",
                                        company_website=None, links=[], notes="notes", updated_by=user, updated_at=now))
        for key, scope, scope_id in (("org_doc", "organization", None), ("kb_doc", "knowledge_base", ids["base"]),
                                     ("prep_doc", "prep", ids["event"])):
            session.add(KnowledgeDocumentRow(id=ids[key], organization_id=org_id, scope=scope, scope_id=scope_id,
                                             filename=f"{key}.pdf", content_type="application/pdf", source_url=None,
                                             size_bytes=100, page_count=1, ocr_page_count=0,
                                             extracted_text="document text " * 30, summary=None, status="indexed",
                                             error=None, created_by=user, created_at=now, indexed_at=now))
            session.add(KnowledgeChunkRow(id=str(uuid4()), organization_id=org_id, scope=scope, scope_id=scope_id,
                                          source_type="document", source_id=ids[key], document_id=ids[key],
                                          meeting_id=None, position=0, title="t", context="c", content="chunk " * 20,
                                          token_count=20, details={}, fingerprint="f" * 64, profile_id=None,
                                          model="m", dimensions=3, embedding=[0.1, 0.2, 0.3], created_at=now,
                                          embedded_at=now))
        session.add(KnowledgeChunkRow(id=str(uuid4()), organization_id=org_id, scope="knowledge_base",
                                      scope_id=ids["base"], source_type="transcript", source_id="t1", document_id=None,
                                      meeting_id=ids["meeting"], position=0, title="t", context="c", content="turn",
                                      token_count=1, details={}, fingerprint="e" * 64, profile_id=None, model="m",
                                      dimensions=3, embedding=[0.1, 0.2, 0.3], created_at=now, embedded_at=now))
        session.add(KnowledgeEmbeddingRow(id=str(uuid4()), organization_id=org_id, knowledge_base_id=ids["base"],
                                          meeting_id=ids["meeting"], source_id="s1", fingerprint="a" * 64,
                                          profile_id=str(uuid4()), model="m", dimensions=3, vector=[0.1, 0.2, 0.3],
                                          updated_at=now))
        session.add(OrganizationBriefDocumentRow(id=ids["brief_doc"], organization_id=org_id, filename="profile.md",
                                                 content_type="text/markdown", extracted_text="profile " * 20,
                                                 uploaded_at=now))
        session.add(UsageEventRow(id=str(uuid4()), organization_id=org_id, kind="llm", purpose="old", provider="p",
                                  model="m", input_tokens=1, output_tokens=1, units=None, unit_type="tokens",
                                  estimated_usd=None, price_source=None, duration_ms=None, status="succeeded",
                                  meeting_id=None, knowledge_base_id=None, prep_event_id=None, actor_user_id=None,
                                  details={}, created_at=now - timedelta(days=100)))
        session.add(AuditEventRow(id=str(uuid4()), organization_id=org_id, actor_user_id=None, action="old.audit",
                                  resource_path="/x", resource_id=None, status_code=200,
                                  created_at=now - timedelta(days=100)))
    return ids


def _count(app, model, *where) -> int:
    with app.state.database.session_factory() as session:
        return session.execute(select(func.count()).select_from(model).where(*where)).scalar_one()


def _purge(client, **payload):
    return client.post("/v1/workspace/storage/purge", json={"confirm": "DELETE", **payload})


def test_storage_accounting_is_per_workspace_and_reports_capture_honestly(tmp_path) -> None:
    fake = FakeVexa()
    app = _app(tmp_path, fake)
    _seed(app, LEGACY_ORGANIZATION_ID)
    with TestClient(app) as client:
        before = client.get("/v1/workspace/storage")
        assert before.status_code == 200, before.text
        body = before.json()
        categories = {item["key"]: item for item in body["categories"]}
        assert set(categories) == {"meetings", "meeting_preps", "documents", "search_index", "knowledge_bases",
                                   "ai_chats", "calendar_cache", "logs", "workspace"}
        for key in ("meetings", "meeting_preps", "documents", "search_index", "ai_chats", "calendar_cache", "logs"):
            assert categories[key]["bytes"] > 0 and categories[key]["rows"] > 0, key
        assert categories["meetings"]["bytes"] > 20 * 480  # transcript text dominates
        assert not categories["workspace"]["purgeable"]
        assert body["total_bytes"] == sum(item["bytes"] for item in body["categories"])
        assert body["database"]["size_bytes"] > 0
        assert body["capture"]["status"] == "not_requested"
        assert "Vexa" in body["capture"]["note"]

        _seed(app, OTHER_ORG, capture_id=99)
        after = {item["key"]: item["bytes"] for item in client.get("/v1/workspace/storage").json()["categories"]}
        assert after == {key: item["bytes"] for key, item in categories.items()}

        capture = client.get("/v1/workspace/storage", params={"include_capture": True}).json()["capture"]
        assert capture == {**capture, "status": "measured", "recording_bytes": 1500, "recordings": 1,
                           "meetings_checked": 1}


def test_storage_items_list_selectable_things_with_sizes(tmp_path) -> None:
    app = _app(tmp_path, FakeVexa())
    ids = _seed(app, LEGACY_ORGANIZATION_ID)
    _seed(app, OTHER_ORG)
    with TestClient(app) as client:
        def items(category, **params):
            response = client.get("/v1/workspace/storage/items", params={"category": category, **params})
            assert response.status_code == 200, response.text
            return response.json()["items"]

        meetings = items("meetings")
        assert [item["id"] for item in meetings] == [ids["meeting"]] and meetings[0]["bytes"] > 0
        assert items("meetings", q="board") and not items("meetings", q="nothing-like-this")
        assert [item["label"] for item in items("meeting_preps")] == ["Acme prep"]
        assert {item["id"] for item in items("documents")} == {ids["org_doc"], ids["kb_doc"], ids["brief_doc"]}
        assert [item["id"] for item in items("knowledge_bases")] == [ids["base"]]
        index_ids = {item["id"] for item in items("search_index")}
        assert index_ids == {ids["base"], "organization", "prep"}
        assert [item["id"] for item in items("ai_chats")] == [ids["conversation"]]
        assert [item["id"] for item in items("calendar_cache")] == ["conn-1"]
        assert {item["id"] for item in items("logs")} == {"usage", "audit"}
        assert client.get("/v1/workspace/storage/items", params={"category": "workspace"}).status_code == 422


def test_purge_meetings_erases_capture_audits_and_is_idempotent(tmp_path) -> None:
    fake = FakeVexa()
    app = _app(tmp_path, fake)
    ids = _seed(app, LEGACY_ORGANIZATION_ID)
    active = _seed(app, LEGACY_ORGANIZATION_ID, capture_id=77, status="active")["meeting"]
    other = _seed(app, OTHER_ORG, capture_id=55)
    with TestClient(app) as client:
        assert _purge(client, category="meetings", ids=[ids["meeting"]], confirm="yes").status_code == 400
        result = _purge(client, category="meetings", ids=[ids["meeting"], active, other["meeting"]])
        assert result.status_code == 200, result.text
        body = result.json()
        assert body["deleted"]["meetings"] == 1
        assert _count(app, KnowledgeChunkRow, KnowledgeChunkRow.meeting_id == ids["meeting"]) == 0
        assert [item["id"] for item in body["skipped"]] == [active]
        assert body["bytes_freed_estimate"] > 0 and body["bytes_after"] < body["bytes_before"]
        assert fake.deleted == [42]
        assert _count(app, MeetingRow, MeetingRow.id == ids["meeting"]) == 0
        assert _count(app, TranscriptSegmentRow, TranscriptSegmentRow.meeting_id == ids["meeting"]) == 0
        assert _count(app, MeetingRow, MeetingRow.id == other["meeting"]) == 1  # other tenant untouched
        assert _count(app, AuditEventRow, AuditEventRow.action == "storage.purge.meetings",
                      AuditEventRow.organization_id == str(LEGACY_ORGANIZATION_ID)) == 1
        again = _purge(client, category="meetings", ids=[ids["meeting"]]).json()
        assert again["deleted"]["meetings"] == 0 and again["bytes_freed_estimate"] == 0
        assert _purge(client, category="meetings", ids=["not-a-uuid"]).status_code == 400


def test_purge_each_remaining_category_is_scoped_and_complete(tmp_path) -> None:
    app = _app(tmp_path, FakeVexa())
    ids = _seed(app, LEGACY_ORGANIZATION_ID)
    other = _seed(app, OTHER_ORG)
    org = str(LEGACY_ORGANIZATION_ID)
    with TestClient(app) as client:
        preps = _purge(client, category="meeting_preps", ids=[ids["event"], other["event"]]).json()
        assert preps["deleted"] == {"briefings": 1, "prep_inputs": 1, "search_chunks": 1, "documents": 1}
        assert _count(app, MeetingPrepRow, MeetingPrepRow.organization_id == str(OTHER_ORG)) == 1

        docs = _purge(client, category="documents", ids=[ids["org_doc"], ids["brief_doc"], other["org_doc"]]).json()
        assert docs["deleted"]["documents"] == 2 and docs["deleted"]["search_chunks"] == 1
        assert _count(app, KnowledgeDocumentRow, KnowledgeDocumentRow.id == other["org_doc"]) == 1
        assert _count(app, OrganizationBriefDocumentRow, OrganizationBriefDocumentRow.organization_id == org) == 0

        index = _purge(client, category="search_index", ids=[ids["base"]], reindex=True).json()
        assert index["deleted"] == {"search_chunks": 2, "embeddings": 1}
        assert index["reindex_queued"] == 2  # one base job + one indexed document marked pending
        assert _count(app, KnowledgeIndexJobRow, KnowledgeIndexJobRow.knowledge_base_id == ids["base"],
                      KnowledgeIndexJobRow.status == "pending") == 1
        assert _count(app, KnowledgeDocumentRow, KnowledgeDocumentRow.id == ids["kb_doc"],
                      KnowledgeDocumentRow.status == "pending") == 1
        assert _count(app, KnowledgeChunkRow, KnowledgeChunkRow.organization_id == str(OTHER_ORG)) == 4

        chats = _purge(client, category="ai_chats", older_than_days=30).json()
        assert chats["deleted"] == {"conversations": 1, "messages": 1}
        assert _count(app, KnowledgeConversationRow, KnowledgeConversationRow.id == other["conversation"]) == 1

        bases = _purge(client, category="knowledge_bases").json()
        assert bases["deleted"]["knowledge_bases"] == 1 and bases["deleted"]["documents"] == 1
        assert _count(app, KnowledgeBaseRow, KnowledgeBaseRow.organization_id == org) == 0
        assert _count(app, KnowledgeBaseRow, KnowledgeBaseRow.organization_id == str(OTHER_ORG)) == 1

        # Re-add a prep, and organizer inputs on another event (a foreign key in PostgreSQL), so the
        # calendar clear must keep both referenced events.
        now = datetime.now(UTC)
        input_event = str(uuid4())
        with app.state.database.session_factory.begin() as session:
            session.add(MeetingPrepRow(id=str(uuid4()), organization_id=org, user_id=str(LEGACY_ADMIN_USER_ID),
                                       calendar_event_id=ids["event"], context="", profile_urls=[], report={},
                                       created_at=now))
            session.add(CalendarEventCacheRow(id=input_event, organization_id=org, user_id=str(LEGACY_ADMIN_USER_ID),
                                              connection_id="conn-1", provider="googlecalendar", event_id="inputs",
                                              starts_at=now, ends_at=now, payload={"title": "Inputs"}, synced_at=now))
            session.flush()
            session.add(MeetingPrepInputRow(calendar_event_id=input_event, organization_id=org, target_company=None,
                                            company_website=None, links=[], notes="", updated_by=None, updated_at=now))
        calendar = _purge(client, category="calendar_cache", ids=["conn-1"])
        assert calendar.status_code == 200, calendar.text
        calendar = calendar.json()
        assert calendar["deleted"] == {"events": 1, "sync_states": 1} and calendar["kept"] == {"events_with_preps": 2}
        assert _count(app, CalendarEventCacheRow, CalendarEventCacheRow.organization_id == str(OTHER_ORG)) == 2

        logs = _purge(client, category="logs", older_than_days=30).json()
        assert logs["deleted"]["usage_events"] == 1 and logs["deleted"]["audit_events"] == 1
        assert _count(app, UsageEventRow, UsageEventRow.organization_id == str(OTHER_ORG)) == 1
        assert _count(app, AuditEventRow, AuditEventRow.organization_id == org,
                      AuditEventRow.action.like("storage.purge.%")) == 7  # recent purge audits survive
        wiped = _purge(client, category="logs", ids=["audit"], older_than_days=0).json()
        assert wiped["deleted"] == {"audit_events": 14}  # 7 purge + 7 request audits
        assert _count(app, AuditEventRow, AuditEventRow.organization_id == org,
                      AuditEventRow.action == "storage.purge.logs") >= 1
        assert _purge(client, category="logs", ids=["secrets"]).status_code == 400
        assert _purge(client, category="workspace").status_code == 422
        assert _purge(client, category="meetings", ids=[]).status_code == 400


def test_retention_removes_prep_inputs_and_uploads_before_expired_calendar_events(tmp_path) -> None:
    import asyncio
    app = _app(tmp_path, FakeVexa())
    ids = _seed(app, LEGACY_ORGANIZATION_ID, capture_id=None)
    other = _seed(app, OTHER_ORG, capture_id=None)
    old = datetime.now(UTC) - timedelta(days=45)
    with app.state.database.session_factory.begin() as session:
        session.execute(update(CalendarEventCacheRow).where(CalendarEventCacheRow.id == ids["event"]).values(ends_at=old))
        session.execute(update(CalendarEventCacheRow).where(CalendarEventCacheRow.id == other["event"]).values(ends_at=old))
    with TestClient(app) as client:
        assert client.put("/v1/workspace/retention", json={
            "enabled": True, "meeting_days": 30, "chat_days": None, "audit_days": None,
        }).status_code == 200
        asyncio.run(app.state.retention.tick())
    org = str(LEGACY_ORGANIZATION_ID)
    assert _count(app, CalendarEventCacheRow, CalendarEventCacheRow.id == ids["event"]) == 0
    for model in (MeetingPrepRow, MeetingPrepInputRow):
        assert _count(app, model, model.organization_id == org) == 0
    assert _count(app, KnowledgeDocumentRow, KnowledgeDocumentRow.id == ids["prep_doc"]) == 0
    assert _count(app, KnowledgeChunkRow, KnowledgeChunkRow.organization_id == org,
                  KnowledgeChunkRow.scope == "prep") == 0
    assert _count(app, KnowledgeDocumentRow, KnowledgeDocumentRow.id == ids["org_doc"]) == 1
    # The other workspace has no retention policy: its expired prep data is untouched.
    assert _count(app, MeetingPrepInputRow, MeetingPrepInputRow.calendar_event_id == other["event"]) == 1
    assert _count(app, CalendarEventCacheRow, CalendarEventCacheRow.id == other["event"]) == 1
