"""Ask AI on a research profile: context assembly, citations, web-search bound, private chats, ledger rows."""

from __future__ import annotations

import pytest
from research_helpers import as_user, build_world, seed_meeting, user_id
from sqlalchemy import select

from app.research_chat import MAX_WEB_SEARCHES, web_queries
from app.research_models import ResearchProfilePublic
from app.database import UsageEventRow


@pytest.fixture()
def world(tmp_path, monkeypatch):
    world = build_world(tmp_path, monkeypatch)
    yield world
    world["client"].__exit__(None, None, None)


def _acme(client) -> dict:
    return client.post("/v1/research/profiles", json={"kind": "company", "apollo_id": "org_acme", "domain": "acme.example"}).json()["profile"]


def _rows(app, purpose: str) -> list[UsageEventRow]:
    with app.state.database.session_factory() as session:
        return list(session.execute(select(UsageEventRow).where(UsageEventRow.purpose == purpose)).scalars())


def test_answer_uses_apollo_facts_and_readable_history_as_untrusted_sources(world) -> None:
    client, app, model = world["client"], world["app"], world["model"]
    mo = user_id(app, "mo@example.com")
    seed_meeting(app, title="Acme discovery", covered=[mo], invitees=[{"name": "Asha Patel", "email": "asha@acme.example"}],
                 minutes="Acme wants a two-site pilot.")
    seed_meeting(app, title="Secret Acme pricing", invitees=[{"name": "Chen", "email": "chen@acme.example"}],
                 minutes="Discount ceiling is 30 percent.")
    as_user(client, "mo")
    profile = _acme(client)
    response = client.post(f"/v1/research/profiles/{profile['id']}/chat", json={"question": "What should I know before the call?"})
    assert response.status_code == 200, response.text
    answer = response.json()
    prompt = model.requests[-1]
    assert prompt.metadata["purpose"] == "research_chat" and prompt.metadata["actor_user_id"] == mo
    assert "untrusted data" in prompt.system_prompt and "<<<" in prompt.prompt
    assert "Apollo structured B2B data" in prompt.prompt and "Acme wants a two-site pilot." in prompt.prompt
    assert "Discount ceiling" not in prompt.prompt  # a meeting Mo can't open is never context
    # Only supplied labels survive as citations (the fake model also cites an unknown S999).
    assert [item["id"] for item in answer["citations"]] == ["S1", "S2"] and answer["citations"][0]["kind"] == "apollo"
    assert "[S1]" in answer["answer"] and answer["web_searches"] == 0 and not world["exa"].requests
    llm = _rows(app, "research_chat")
    assert len(llm) == 1 and llm[0].kind == "llm" and llm[0].actor_user_id == mo


def test_web_search_is_opt_in_bounded_and_ledgered(world) -> None:
    client, app, exa = world["client"], world["app"], world["exa"]
    app.state.research.chat_engine.environ = {"EXA_API_KEY": "exa-test-key"}
    as_user(client, "mo")
    profile = _acme(client)
    response = client.post(f"/v1/research/profiles/{profile['id']}/chat",
                           json={"question": "Any recent news or funding announcements?", "include_web": True})
    assert response.status_code == 200, response.text
    body = response.json()
    assert 1 <= body["web_searches"] == len(exa.requests) <= MAX_WEB_SEARCHES
    assert "Acme is expanding in Europe." in world["model"].requests[-1].prompt
    rows = [row for row in _rows(app, "research_chat") if row.provider == "exa"]
    assert len(rows) == len(exa.requests) and all(row.actor_user_id == user_id(app, "mo@example.com") for row in rows)


def test_web_queries_never_exceed_the_bound() -> None:
    from datetime import UTC, datetime
    from uuid import uuid4
    now = datetime.now(UTC)
    profile = ResearchProfilePublic(id=uuid4(), kind="company", apollo_id=None, domain="acme.example", name="Acme",
                                    created_at=now, updated_at=now, fetched_at=now)
    assert len(web_queries(profile, "latest news funding launch hiring acquisitions")) <= MAX_WEB_SEARCHES


def test_web_search_without_an_exa_key_answers_from_saved_data_with_a_note(world) -> None:
    client = world["client"]
    as_user(client, "mo")
    profile = _acme(client)
    body = client.post(f"/v1/research/profiles/{profile['id']}/chat", json={"question": "What's new?", "include_web": True}).json()
    assert body["web_searches"] == 0 and "Web search isn't set up" in body["note"] and not world["exa"].requests


def test_chats_are_private_per_person_and_deletable(world) -> None:
    client = world["client"]
    as_user(client, "mo")
    profile = _acme(client)
    first = client.post(f"/v1/research/profiles/{profile['id']}/chat", json={"question": "Who leads engineering?"}).json()
    conversation = first["conversation_id"]
    follow = client.post(f"/v1/research/profiles/{profile['id']}/chat",
                         json={"question": "And their background?", "conversation_id": conversation}).json()
    assert follow["conversation_id"] == conversation
    assert "Who leads engineering?" in world["model"].requests[-1].prompt  # earlier turns resolve references
    stored = client.get(f"/v1/research/profiles/{profile['id']}/conversations/{conversation}").json()
    assert [message["role"] for message in stored["messages"]] == ["user", "assistant", "user", "assistant"]
    assert stored["messages"][1]["citations"][0]["id"] == "S1"
    as_user(client, "mia")
    assert client.get(f"/v1/research/profiles/{profile['id']}/conversations").json() == []
    assert client.get(f"/v1/research/profiles/{profile['id']}/conversations/{conversation}").status_code == 404
    assert client.delete(f"/v1/research/profiles/{profile['id']}/conversations/{conversation}").status_code == 404
    reply = client.post(f"/v1/research/profiles/{profile['id']}/chat",
                        json={"question": "Hijack?", "conversation_id": conversation})
    assert reply.status_code == 404
    as_user(client, "mo")
    assert client.delete(f"/v1/research/profiles/{profile['id']}/conversations/{conversation}").status_code == 204
    assert client.get(f"/v1/research/profiles/{profile['id']}/conversations").json() == []


def test_question_validation_and_viewers(world) -> None:
    client = world["client"]
    as_user(client, "mo")
    profile = _acme(client)
    assert client.post(f"/v1/research/profiles/{profile['id']}/chat", json={"question": "hi"}).status_code == 422
    assert client.post(f"/v1/research/profiles/{profile['id']}/chat", json={"question": "x" * 801}).status_code == 422
    as_user(client, "vic")
    assert client.post(f"/v1/research/profiles/{profile['id']}/chat", json={"question": "Who is this?"}).status_code == 403


def test_deleting_a_meeting_removes_research_chats_that_quote_it(world) -> None:
    client, app = world["client"], world["app"]
    mo = user_id(app, "mo@example.com")
    meeting = seed_meeting(app, title="Acme discovery", covered=[mo], invitees=[{"name": "Asha", "email": "asha@acme.example"}],
                           minutes="Acme wants a two-site pilot.")
    as_user(client, "mo")
    profile = _acme(client)
    world["model"].requests.clear()

    async def cite_meeting(_, request):
        world["model"].requests.append(request)
        label = next(line.split("]")[0][1:] for line in request.prompt.splitlines() if "approved minutes" in line)
        from meetings_contracts import TextGenerationResult
        payload = {"answer": f"Pilot [{label}].", "citation_ids": [label]}
        return TextGenerationResult(text="", structured_output=payload, provider="fake", model="fake-chat")
    world["model"].generate_text = lambda profile_, request: cite_meeting(profile_, request)
    chat = client.post(f"/v1/research/profiles/{profile['id']}/chat", json={"question": "What did they want?"}).json()
    assert chat["citations"][0]["meeting_id"] == meeting
    as_user(client, "owner")
    assert client.delete(f"/v1/meetings/{meeting}").status_code in {200, 204}
    as_user(client, "mo")
    assert client.get(f"/v1/research/profiles/{profile['id']}/conversations").json() == []


def test_the_same_page_from_two_web_searches_is_cited_once() -> None:
    from app.research_chat import SourceList

    book = SourceList()
    first = book.add(title="Acme raises Series C", url="https://news.example/acme-c", origin="web", excerpt="short")
    other = book.add(title="Acme hires a CTO", url="https://news.example/acme-cto", origin="web", excerpt="x")
    again = book.add(title="Acme raises Series C", url="https://news.example/acme-c", origin="web",
                     excerpt="a longer excerpt of the same article")
    assert (first, other, again) == ("S1", "S2", "S1")
    assert len(book.labels()) == 2 and "a longer excerpt" in book.render()
