"""Fail closed on unsafe production settings without printing secret values."""

from urllib.parse import urlsplit


def validate_runtime_config(
    *,
    app_env: str,
    database_url: str,
    credential_key: str,
    admin_password: str,
    session_secret: str,
    web_origin: str,
    vexa_api_key: str,
    stt_override_secret: str,
) -> None:
    if app_env != "production":
        return
    invalid: list[str] = []
    if not database_url.startswith("postgresql+psycopg://"):
        invalid.append("DATABASE_URL must use PostgreSQL")
    if credential_key == "development-only-change-me" or len(credential_key) < 32:
        invalid.append("PROVIDER_CREDENTIAL_KEY must be a unique secret of at least 32 characters")
    if len(admin_password) < 16:
        invalid.append("MEETINGS_AI_ADMIN_PASSWORD must be at least 16 characters")
    if len(session_secret) < 32:
        invalid.append("MEETINGS_AI_SESSION_SECRET must be at least 32 characters")
    origin = urlsplit(web_origin)
    if (
        origin.scheme != "https" or not origin.hostname
        or origin.hostname in {"localhost", "127.0.0.1", "::1"}
        or origin.username or origin.password or origin.path not in {"", "/"}
        or origin.query or origin.fragment
    ):
        invalid.append("WEB_ORIGIN must be a public HTTPS origin")
    if not vexa_api_key:
        invalid.append("VEXA_API_KEY is required")
    if len(stt_override_secret) < 32:
        invalid.append("VEXA_STT_OVERRIDE_SECRET must be at least 32 characters")
    if invalid:
        raise RuntimeError("unsafe production configuration: " + "; ".join(invalid))
