"""Application configuration.

All values can be overridden with environment variables or a .env file.
See docs/ENV.md for the full reference.
"""
from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic import Field, field_validator
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
    # SQLite is used for local development, PostgreSQL in production.
    database_url: str = Field(default="sqlite:///./data/examguard.db")
    auto_create_tables: bool = Field(default=True)

    # --- Secrets ----------------------------------------------------------
    secret_key: str = Field(default="change-me-in-production")
    # One-time secret required by the first-run setup page.
    setup_secret: str = Field(default="")
    # Set to true after the first-run setup has been completed (also stored in DB).
    setup_disabled: bool = Field(default=False)

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
    cors_origins: str = Field(
        default="http://localhost:5173,http://127.0.0.1:5173,"
        "https://exam.heda.my.id"
    )

    # --- Runtime ----------------------------------------------------------
    expiry_sweep_seconds: int = Field(default=5)

    # --- Helpers ----------------------------------------------------------
    @field_validator("database_url")
    @classmethod
    def _normalize_sqlite_url(cls, value: str) -> str:
        if value.startswith("postgres://"):
            return value.replace("postgres://", "postgresql+psycopg://", 1)
        if value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg://", 1)
        return value

    @property
    def cors_origin_list(self) -> List[str]:
        return [item.strip() for item in self.cors_origins.split(",") if item.strip()]

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
