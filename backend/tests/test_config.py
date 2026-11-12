"""Configuration normalization for Docker-provided environment values."""
from __future__ import annotations

from app.config import Settings


def test_blank_cookie_domain_becomes_none() -> None:
    # docker compose passes ``COOKIE_DOMAIN: ""`` when the variable is unset.
    # An empty Domain attribute would make browsers reject the session cookie.
    assert Settings(cookie_domain="").cookie_domain is None
    assert Settings(cookie_domain="   ").cookie_domain is None


def test_explicit_cookie_domain_is_kept() -> None:
    assert Settings(cookie_domain="exam.heda.my.id").cookie_domain == "exam.heda.my.id"


def test_postgres_urls_are_normalized_to_psycopg() -> None:
    assert (
        Settings(database_url="postgres://u:p@db:5432/exam").database_url
        == "postgresql+psycopg://u:p@db:5432/exam"
    )
    assert (
        Settings(database_url="postgresql://u:p@db:5432/exam").database_url
        == "postgresql+psycopg://u:p@db:5432/exam"
    )


def test_unexpanded_compose_placeholder_is_rejected() -> None:
    """Regression: `${VAR}` inside a Compose default is not expanded.

    The API then received a DSN containing a literal ``${POSTGRES_PASSWORD}``,
    failed to connect, and the container sat in "Waiting" for ~136 s before
    being reported as unhealthy. Validation must fail immediately instead.
    """
    import pytest

    with pytest.raises(Exception) as excinfo:
        Settings(database_url="postgresql+psycopg://u:${POSTGRES_PASSWORD}@db:5432/exam")
    assert "placeholder" in str(excinfo.value)


def test_cors_origins_fall_back_to_public_base_url() -> None:
    settings = Settings(cors_origins="", public_base_url="https://exam.example.com")
    assert settings.cors_origin_list[0] == "https://exam.example.com"
    # Local development origins are always allowed.
    assert "http://localhost:5173" in settings.cors_origin_list


def test_explicit_cors_origins_are_used_verbatim() -> None:
    settings = Settings(cors_origins="https://a.example.com, https://b.example.com")
    assert settings.cors_origin_list == ["https://a.example.com", "https://b.example.com"]
