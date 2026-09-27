"""GET /v1/model-catalog: per-capability model lists for OpenAI, OpenRouter and compatible endpoints."""

import httpx
from fastapi.testclient import TestClient

from app.main import create_app
from app.model_catalog_rules import openai_models, openrouter_models

from test_credential_vault import OWNER_EMAIL, OWNER_PASSWORD, _invite, _login

OPENAI_KEY = "sk-openai-profile-key-7777"
PASTED_KEY = "sk-pasted-editor-key-8888"

ROUTER_LLMS = [
    {"id": "openai/gpt-6-luna", "name": "OpenAI: GPT-6 Luna", "context_length": 400000,
     "architecture": {"input_modalities": ["file", "image", "text"], "output_modalities": ["text"]},
     "pricing": {"prompt": "0.0000001", "completion": "0.0000005"}},
    {"id": "vendor/text-only", "name": "Vendor: Text only",
     "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
     "pricing": {"prompt": "0.000002", "completion": "0.00001"}},
    {"id": "vendor/router", "name": "Vendor: Router",
     "architecture": {"input_modalities": ["image", "text"], "output_modalities": ["text"]},
     "pricing": {"prompt": "-1", "completion": "-1"}},
    {"id": "vendor/painter", "name": "Vendor: Painter",
     "architecture": {"input_modalities": ["text"], "output_modalities": ["image"]}},
]
ROUTER_STT = [
    {"id": "openai/whisper-1", "name": "OpenAI: Whisper 1", "architecture": {"output_modalities": ["transcription"]},
     "pricing": {"prompt": "0.0001", "completion": "0"}},
    {"id": "openai/gpt-4o-transcribe", "name": "OpenAI: GPT-4o Transcribe",
     "architecture": {"output_modalities": ["transcription"]}, "pricing": {"prompt": "0.0000025", "completion": "0.00001"}},
    {"id": "vendor/odd-unit", "name": "Vendor: Odd unit", "architecture": {"output_modalities": ["transcription"]},
     "pricing": {"prompt": "0.1", "completion": "0"}},
]
ROUTER_EMBEDDINGS = [
    {"id": "openai/text-embedding-3-small", "name": "OpenAI: Text Embedding 3 Small",
     "architecture": {"output_modalities": ["embeddings"]}, "pricing": {"prompt": "0.00000002", "completion": "0"}},
]
OPENAI_IDS = [
    "gpt-6-luna", "gpt-6-sol", "gpt-4o-audio-preview", "gpt-realtime", "gpt-image-1", "o4-mini", "omni-moderation-latest",
    "gpt-4o-search-preview", "tts-1", "whisper-1", "gpt-4o-transcribe", "text-embedding-3-small", "dall-e-3",
]


def test_openrouter_rules_filter_by_capability_and_keep_prices_honest() -> None:
    text = openrouter_models(ROUTER_LLMS, "text_generation")
    assert [item.id for item in text] == ["openai/gpt-6-luna", "vendor/text-only", "vendor/router"]
    assert (text[0].name, text[0].vendor, text[0].context_length) == ("GPT-6 Luna", "OpenAI", 400000)
    assert (text[0].input_per_million_usd, text[0].output_per_million_usd, text[0].accepts_images) == (0.1, 0.5, True)
    assert text[2].input_per_million_usd is None  # "-1" means variable pricing, not free
    assert [item.id for item in openrouter_models(ROUTER_LLMS, "vision")] == ["openai/gpt-6-luna", "vendor/router"]

    stt = {item.id: item for item in openrouter_models(ROUTER_STT, "transcription")}
    assert stt["openai/whisper-1"].usd_per_minute == 0.006  # USD per audio second x 60
    assert (stt["openai/gpt-4o-transcribe"].input_per_million_usd, stt["openai/gpt-4o-transcribe"].usd_per_minute) == (2.5, None)
    assert stt["vendor/odd-unit"].usd_per_minute is None  # implausible per-minute rate stays unpriced

    embedding = openrouter_models(ROUTER_EMBEDDINGS, "embeddings")[0]
    assert (embedding.input_per_million_usd, embedding.output_per_million_usd) == (0.02, None)


def test_openai_rules_classify_by_id_and_use_published_prices_only() -> None:
    rows = [{"id": item} for item in OPENAI_IDS]
    prices = {"text_prices": {"gpt-6-luna": (0.1, 0.5)}, "embedding_prices": {"text-embedding-3-small": 0.02},
              "stt_prices": {"whisper-1": 0.006}, "image_models": frozenset({"gpt-6-luna"})}
    text = openai_models(rows, "text_generation", **prices)
    assert [item.id for item in text] == ["gpt-6-luna", "gpt-6-sol", "o4-mini"]
    assert (text[0].input_per_million_usd, text[1].input_per_million_usd) == (0.1, None)
    assert [item.id for item in openai_models(rows, "vision", **prices)] == ["gpt-6-luna"]
    stt = openai_models(rows, "transcription", **prices)
    assert [(item.id, item.usd_per_minute) for item in stt] == [("gpt-4o-transcribe", None), ("whisper-1", 0.006)]
    assert [item.id for item in openai_models(rows, "embeddings", **prices)] == ["text-embedding-3-small"]


class _Recorder:
    def __init__(self, addresses: list[str] | None = None) -> None:
        self.requests: list[httpx.Request] = []
        self.addresses = addresses or ["93.184.216.34"]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.host == "api.openai.com":
            if request.headers.get("Authorization") == "Bearer sk-rejected-key-0000":
                return httpx.Response(401, json={"error": "invalid"})
            return httpx.Response(200, json={"data": [{"id": item} for item in OPENAI_IDS]})
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json={"data": ROUTER_EMBEDDINGS})
        if request.url.params.get("output_modalities") == "transcription":
            return httpx.Response(200, json={"data": ROUTER_STT})
        if request.url.host == "openrouter.ai":
            return httpx.Response(200, json={"data": ROUTER_LLMS})
        return httpx.Response(200, json={"object": "list", "data": [
            {"id": "llama-4-chat"}, {"id": "nomic-embed-text"}, {"id": "faster-whisper-small"},
        ]})

    async def resolve(self, host: str, port: int) -> list[str]:
        return self.addresses


def _app(tmp_path, recorder: _Recorder):
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'catalog.db'}", credential_key="test-credential-key")
    catalog = app.state.ai_settings.model_catalog
    catalog.transport, catalog.resolver, catalog._browser = httpx.MockTransport(recorder), recorder.resolve, None
    return app


def _profile(client, **overrides) -> str:
    body = {"name": "OpenAI minutes", "provider_type": "openai", "execution_location": "cloud",
            "api_key": OPENAI_KEY, "capabilities": [{"capability": "text_generation", "model": "gpt-6-sol"}], **overrides}
    response = client.post("/v1/provider-profiles", json=body)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_openrouter_lists_are_public_cached_and_capability_specific(tmp_path) -> None:
    recorder = _Recorder()
    with TestClient(_app(tmp_path, recorder)) as client:
        vision = client.get("/v1/model-catalog", params={"provider": "openrouter", "capability": "vision"})
        assert vision.status_code == 200, vision.text
        body = vision.json()
        assert body["live_catalog"] is True and body["provider"] == "openrouter"
        assert [item["id"] for item in body["models"]] == ["openai/gpt-6-luna", "vendor/router"]
        assert "Authorization" not in recorder.requests[0].headers  # public catalog: no key sent
        # text_generation reuses the cached LLM list; no second request.
        assert len(client.get("/v1/model-catalog", params={"provider": "openrouter", "capability": "text_generation"}).json()["models"]) == 3
        assert len(recorder.requests) == 1
        stt = client.get("/v1/model-catalog", params={"provider": "openrouter", "capability": "transcription"}).json()
        assert stt["models"][0]["usd_per_minute"] == 0.006
        embeddings = client.get("/v1/model-catalog", params={"provider": "openrouter", "capability": "embeddings"}).json()
        assert embeddings["models"][0]["id"] == "openai/text-embedding-3-small"
        assert [str(item.url) for item in recorder.requests[1:]] == [
            "https://openrouter.ai/api/v1/models?output_modalities=transcription",
            "https://openrouter.ai/api/v1/embeddings/models",
        ]


def test_openai_lists_use_profile_or_pasted_key_and_never_echo_it(tmp_path) -> None:
    recorder = _Recorder()
    with TestClient(_app(tmp_path, recorder)) as client:
        profile_id = _profile(client)
        listed = client.get("/v1/model-catalog", params={"profile_id": profile_id, "capability": "transcription"})
        assert listed.status_code == 200, listed.text
        assert [item["id"] for item in listed.json()["models"]] == ["gpt-4o-transcribe", "whisper-1"]
        assert recorder.requests[-1].headers["Authorization"] == f"Bearer {OPENAI_KEY}"
        assert OPENAI_KEY not in listed.text

        pasted = client.get("/v1/model-catalog", params={"provider": "openai", "capability": "text_generation"},
                            headers={"X-Provider-Key": PASTED_KEY})
        assert pasted.status_code == 200 and PASTED_KEY not in pasted.text
        assert recorder.requests[-1].headers["Authorization"] == f"Bearer {PASTED_KEY}"
        assert pasted.json()["models"][0] == {
            "id": "gpt-6-luna", "name": "gpt-6-luna", "vendor": "OpenAI", "input_per_million_usd": 0.1,
            "output_per_million_usd": 0.5, "usd_per_minute": None, "context_length": None, "accepts_images": True,
        }
        vision = client.get("/v1/model-catalog", params={"profile_id": profile_id, "capability": "vision"}).json()
        assert [item["id"] for item in vision["models"]] == ["gpt-6-luna"] and vision["note"]

        no_key = client.get("/v1/model-catalog", params={"provider": "openai", "capability": "embeddings"}).json()
        assert no_key["models"] == [] and no_key["live_catalog"] is False and "API key" in no_key["note"]
        rejected = client.get("/v1/model-catalog", params={"provider": "openai", "capability": "embeddings"},
                              headers={"X-Provider-Key": "sk-rejected-key-0000"})
        assert rejected.status_code == 422 and "rejected" in rejected.json()["detail"]


def test_request_mismatches_are_rejected_before_any_key_leaves(tmp_path) -> None:
    recorder = _Recorder()
    with TestClient(_app(tmp_path, recorder)) as client:
        profile_id = _profile(client)
        router_key = client.post("/v1/credentials", json={
            "label": "Router", "provider_type": "openrouter", "secret": "sk-or-vault-key-1234"}).json()
        local_key = client.post("/v1/credentials", json={
            "label": "Local", "provider_type": "openai_compatible", "secret": "local-key-1234",
            "base_url": "https://llm.example.com/v1"}).json()
        for params in (
            {"capability": "text_generation"},
            {"capability": "text_generation", "provider": "openrouter", "profile_id": profile_id},
            {"capability": "text_generation", "provider": "openai", "credential_id": router_key["id"]},
            {"capability": "text_generation", "credential_id": local_key["id"], "base_url": "https://evil.example.net/v1"},
            {"capability": "text_generation", "provider": "openai_compatible"},
            {"capability": "text_generation", "provider": "openai_compatible", "base_url": "ftp://llm.example.com"},
            {"capability": "speech", "provider": "openrouter"},
        ):
            assert client.get("/v1/model-catalog", params=params).status_code == 422, params
        assert client.get("/v1/model-catalog", params={
            "capability": "embeddings", "credential_id": "00000000-0000-4000-8000-00000000dead"}).status_code == 404
        assert recorder.requests == []


def test_compatible_endpoints_are_ssrf_safe_unless_a_local_profile_uses_them(tmp_path) -> None:
    recorder = _Recorder(addresses=["10.0.0.7"])
    with TestClient(_app(tmp_path, recorder)) as client:
        params = {"provider": "openai_compatible", "capability": "embeddings", "base_url": "https://llm.example.com/v1"}
        private = client.get("/v1/model-catalog", params=params).json()
        assert private["models"] == [] and private["live_catalog"] is False and private["note"]
        local = {"provider": "openai_compatible", "capability": "text_generation", "base_url": "http://localhost:4000/v1"}
        assert client.get("/v1/model-catalog", params=local).json()["models"] == []
        assert recorder.requests == []  # nothing was sent to a private address

        recorder.addresses = ["93.184.216.34"]
        public = client.get("/v1/model-catalog", params=params, headers={"X-Provider-Key": PASTED_KEY}).json()
        assert [item["id"] for item in public["models"]] == ["nomic-embed-text"]
        pinned = recorder.requests[-1]
        assert pinned.url.host == "93.184.216.34" and pinned.headers["Host"] == "llm.example.com"
        assert pinned.headers["Authorization"] == f"Bearer {PASTED_KEY}"

        _profile(client, name="Local LLM", provider_type="openai_compatible", execution_location="local",
                 base_url="http://localhost:4000/v1", api_key=None)
        allowed = client.get("/v1/model-catalog", params=local).json()
        assert [item["id"] for item in allowed["models"]] == ["llama-4-chat"]
        assert str(recorder.requests[-1].url) == "http://localhost:4000/v1/models"


def test_catalog_is_for_admins_and_automatic_vision_is_shown_to_the_owner(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    recorder = _Recorder()
    with TestClient(_app(tmp_path, recorder)) as client:
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        profile_id = _profile(client)
        assert client.put("/v1/provider-defaults/text_generation", json={
            "policy": "cloud_only", "cloud_profile_id": profile_id}).status_code == 200
        owner_view = client.get("/v1/ai/settings").json()
        assert owner_view["automatic_vision"] == {
            "profile_id": profile_id, "profile_name": "OpenAI minutes", "provider": "openai",
            "model": "gpt-6-luna", "source": "workspace_default",
        }
        _invite(client, "admin@example.com", "admin")
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        _invite(client, "member@example.com", "member")

        _login(client, "member@example.com", "member-long-password-123")
        assert client.get("/v1/model-catalog", params={"provider": "openrouter", "capability": "vision"}).status_code == 403
        assert client.get("/v1/ai/settings").json()["automatic_vision"] is None
        client.post("/v1/auth/logout")

        _login(client, "admin@example.com", "admin-long-password-123")
        assert client.get("/v1/model-catalog", params={"provider": "openrouter", "capability": "vision"}).status_code == 200
