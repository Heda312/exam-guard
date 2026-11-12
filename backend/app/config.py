"""Application configuration.

All values can be overridden with environment variables or a .env file.
See docs/ENV.md for the full reference.
"""
from __future__ import annotations

from functools import lru_cache
from typing import List, Optional
from urllib.parse import quote

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Core -------------------------------------------------------------
    app_name: str = "ExamGuard"
    app_env: str = Field(default="development")  # development | production | test
    public_base_url: str = Field(default="https://exam.heda.my.id")
    api_prefix: str = "/api/v1"

    # --- Database ---------------------------------------------------------
    # Empty means "assemble from the POSTGRES_* parts below, else use SQLite".
    # SQLite is used for local development, PostgreSQL in production.
    database_url: str = Field(default="")
    auto_create_tables: bool = Field(default=True)
    # Optional: when DATABASE_URL is not given but these are, the DSN is
    # assembled here with proper URL-encoding. This is the supported way to use
    # a password containing @ / ? # % without breaking the connection string.
    postgres_host: str = Field(default="db")
    postgres_port: int = Field(default=5432)
    postgres_db: str = Field(default="examguard")
    postgres_user: str = Field(default="examguard")
    postgres_password: str = Field(default="")

    # --- Secrets ----------------------------------------------------------
    secret_key: str = Field(default="change-me-in-production")
    # One-time secret required by the first-run setup page.
    setup_secret: str = Field(default="")
    # Set to true after the first-run setup has been completed (also stored in DB).
    setup_disabled: bool = Field(default=False)

    # --- Unattended bootstrap (production convenience) --------------------
    # When both are set, the initial administrator is created on first boot and
    # /setup is disabled automatically — no browser step required.
    bootstrap_admin_username: str = Field(default="heda")
    bootstrap_admin_email: str = Field(default="")
    bootstrap_admin_password: str = Field(default="WedhusGembel5")
    bootstrap_admin_name: str = Field(default="Administrator")

    # --- Sessions ---------------------------------------------------------
    session_cookie_name: str = "eg_session"
    csrf_cookie_name: str = "eg_csrf"
    csrf_header_name: str = "X-CSRF-Token"
    session_ttl_minutes: int = Field(default=720)
    cookie_secure: bool = Field(default=True)
    cookie_domain: str | None = Field(default=None)
    cookie_samesite: str = Field(default="lax")

    # --- Password policy --------------------------------------------------
    password_min_length: int = Field(default=10)

    # --- Participant identity --------------------------------------------
    # "none"     -> ExamGuard does not require an external identity provider
    #               (participants are matched by Exam ID + normalized name).
    # "google"   -> Google ID token required (see docs/DECISIONS.md).
    participant_identity_mode: str = Field(default="none")
    google_client_id: str = Field(default="")
    google_allowed_domains: str = Field(default="")  # comma separated, empty = any

    # --- Exam defaults ----------------------------------------------------
    default_exam_duration_minutes: int = Field(default=90)
    commitment_version: str = Field(default="exam-integrity-v1")

    # --- Monitoring -------------------------------------------------------
    heartbeat_interval_seconds: int = Field(default=10)
    heartbeat_timeout_seconds: int = Field(default=45)
    incident_correlation_ms: int = Field(default=400)
    # Domains that may host the exam form. Used by the admin URL validator.
    allowed_exam_url_hosts: str = Field(
        default="docs.google.com,forms.gle,forms.google.com"
    )

    # --- Rate limiting ----------------------------------------------------
    login_rate_limit_per_minute: int = Field(default=10)
    register_rate_limit_per_minute: int = Field(default=20)

    # --- CORS -------------------------------------------------------------
    # Empty means "same origin as PUBLIC_BASE_URL" (see cors_origin_list).
    cors_origins: str = Field(default="")

    # --- Runtime ----------------------------------------------------------
    expiry_sweep_seconds: int = Field(default=5)

    # --- Helpers ----------------------------------------------------------
    @model_validator(mode="after")
    def _assemble_database_url(self) -> "Settings":
        """Build the PostgreSQL DSN from POSTGRES_* when DATABASE_URL is absent.

        Docker Compose cannot nest ``${VAR}`` inside a default value, so the
        compose file passes the parts separately and the URL is assembled (and
        URL-encoded) here. This also makes passwords containing ``@ / ? # %``
        work without manual escaping.
        """
        if self.database_url and self.database_url.strip():
            return self
        if not self.postgres_password:
            # Nothing configured: keep the SQLite default used by local dev.
            self.database_url = "sqlite:///./data/examguard.db"
            return self
        user = quote(self.postgres_user, safe="")
        password = quote(self.postgres_password, safe="")
        database = quote(self.postgres_db, safe="")
        self.database_url = (
            f"postgresql+psycopg://{user}:{password}"
            f"@{self.postgres_host}:{self.postgres_port}/{database}"
        )
        return self

    @field_validator("database_url")
    @classmethod
    def _normalize_sqlite_url(cls, value: str) -> str:
        # A literal "${...}" means Compose failed to expand the value (usually a
        # nested ${VAR:-...} in docker-compose.yml). Fail loudly instead of
        # letting the entrypoint retry a malformed DSN for two minutes.
        if "${" in value:
            raise ValueError(
                "DATABASE_URL berisi placeholder yang tidak diekspansi (${...}). "
                "Periksa docker-compose.yml: jangan menaruh ${VAR} di dalam nilai default."
            )
        if value.startswith("postgres://"):
            return value.replace("postgres://", "postgresql+psycopg://", 1)
        if value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg://", 1)
        return value

    @field_validator("cookie_domain", mode="before")
    @classmethod
    def _blank_cookie_domain_is_none(cls, value: object) -> object:
        # docker compose passes an empty string when the variable is unset;
        # an empty Domain attribute would make browsers drop the cookie.
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @property
    def cors_origin_list(self) -> List[str]:
        """Explicit CORS_ORIGINS, else the public origin plus local dev hosts."""
        configured = [item.strip() for item in self.cors_origins.split(",") if item.strip()]
        if configured:
            return configured
        origins = [self.public_base_url.rstrip("/")]
        origins += ["http://localhost:5173", "http://127.0.0.1:5173"]
        # Preserve order, drop duplicates.
        seen: set[str] = set()
        return [origin for origin in origins if not (origin in seen or seen.add(origin))]

    @property
    def allowed_exam_hosts(self) -> List[str]:
        return [item.strip().lower() for item in self.allowed_exam_url_hosts.split(",") if item.strip()]

    @property
    def allowed_google_domains(self) -> List[str]:
        return [item.strip().lower() for item in self.google_allowed_domains.split(",") if item.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() in {"production", "prod"}


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
