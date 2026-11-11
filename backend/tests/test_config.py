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
