import pytest

from app.runtime_config import validate_runtime_config


def _settings() -> dict[str, str]:
    return {
        "app_env": "production",
        "database_url": "postgresql+psycopg://user:password@db:5432/meetings",
        "credential_key": "c" * 32,
        "admin_password": "a" * 16,
        "session_secret": "s" * 32,
        "web_origin": "https://meetings.example.test",
        "vexa_api_key": "private-vexa-token",
        "stt_override_secret": "v" * 32,
    }


def test_production_config_accepts_explicit_secure_values() -> None:
    validate_runtime_config(**_settings())


def test_production_config_rejects_development_defaults_without_secret_values() -> None:
    settings = _settings()
    settings.update({
        "database_url": "sqlite+pysqlite:///:memory:",
        "credential_key": "development-only-change-me",
        "admin_password": "short",
        "session_secret": "short",
        "web_origin": "http://localhost:3020",
        "vexa_api_key": "",
        "stt_override_secret": "",
    })
    with pytest.raises(RuntimeError, match="unsafe production configuration") as error:
        validate_runtime_config(**settings)
    message = str(error.value)
    for name in (
        "DATABASE_URL", "PROVIDER_CREDENTIAL_KEY", "MEETINGS_AI_ADMIN_PASSWORD",
        "MEETINGS_AI_SESSION_SECRET", "WEB_ORIGIN", "VEXA_API_KEY",
        "VEXA_STT_OVERRIDE_SECRET",
    ):
        assert name in message
    assert "development-only-change-me" not in message


def test_development_config_does_not_require_production_integrations() -> None:
    settings = _settings()
    settings.update({
        "app_env": "development", "database_url": "sqlite+pysqlite:///:memory:",
        "vexa_api_key": "", "stt_override_secret": "",
    })
    validate_runtime_config(**settings)


def test_production_origin_cannot_point_to_localhost() -> None:
    settings = _settings()
    settings["web_origin"] = "https://localhost:3020"
    with pytest.raises(RuntimeError, match="WEB_ORIGIN"):
        validate_runtime_config(**settings)
