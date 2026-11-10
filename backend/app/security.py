"""Password hashing, opaque session tokens and CSRF helpers."""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from .config import settings

# Argon2id is the default in argon2-cffi's PasswordHasher.
_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: Optional[str]) -> bool:
    if not password_hash:
        return False
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


def validate_password_strength(password: str) -> None:
    """Raise ValueError when the password does not satisfy the policy."""
    if len(password) < settings.password_min_length:
        raise ValueError(f"Kata sandi minimal {settings.password_min_length} karakter.")
    if password.lower() in {"password", "12345678", "admin12345", "qwerty1234"}:
        raise ValueError("Kata sandi terlalu mudah ditebak.")
    has_letter = any(ch.isalpha() for ch in password)
    has_digit = any(ch.isdigit() for ch in password)
    if not (has_letter and has_digit):
        raise ValueError("Kata sandi harus memuat huruf dan angka.")


def new_opaque_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_csrf_token() -> str:
    return secrets.token_urlsafe(24)


def constant_time_equals(a: str | None, b: str | None) -> bool:
    if not a or not b:
        return False
    return hmac.compare_digest(a, b)


def session_expiry() -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=settings.session_ttl_minutes)


def verify_setup_secret(candidate: str | None) -> bool:
    """Compare the first-run setup secret in constant time."""
    if not settings.setup_secret:
        # No setup secret configured: refuse rather than allow an open setup page.
        return False
    return constant_time_equals(candidate, settings.setup_secret)
