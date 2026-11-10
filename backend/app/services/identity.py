"""Participant external identity verification.

Spec v1.3 §5.2 requires Google authentication. Per the project decision recorded
in docs/DECISIONS.md, Google sign-in is treated as an *optional* institutional
policy: when ``PARTICIPANT_IDENTITY_MODE=none`` (the default) ExamGuard does not
require it, and when set to ``google`` the backend verifies the OIDC ID token.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Optional
from urllib.request import urlopen

from ..config import settings

logger = logging.getLogger(__name__)

GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}


@dataclass
class VerifiedIdentity:
    subject: str
    email: Optional[str]
    name: Optional[str]


class IdentityError(Exception):
    pass


def google_auth_required() -> bool:
    return settings.participant_identity_mode == "google"


def _fetch_jwks() -> dict:
    with urlopen(GOOGLE_CERTS_URL, timeout=10) as response:  # noqa: S310 - fixed HTTPS URL
        return json.loads(response.read().decode("utf-8"))


def verify_google_id_token(token: str) -> VerifiedIdentity:
    """Validate a Google ID token: signature, issuer, audience and expiry."""
    if not settings.google_client_id:
        raise IdentityError("GOOGLE_CLIENT_ID belum dikonfigurasi pada server.")
    if not token:
        raise IdentityError("ID token Google tidak ditemukan.")

    try:
        from jwt import PyJWKClient
        import jwt
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise IdentityError("Dukungan verifikasi token tidak tersedia pada server.") from exc

    try:
        signing_key = PyJWKClient(GOOGLE_CERTS_URL).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=settings.google_client_id,
            options={"require": ["exp", "iat", "aud", "iss", "sub"]},
        )
    except Exception as exc:  # noqa: BLE001 - normalise library errors
        logger.warning("Google ID token verification failed: %s", exc)
        raise IdentityError("Autentikasi Google tidak valid atau kedaluwarsa.") from exc

    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise IdentityError("Issuer token tidak dikenal.")

    email = claims.get("email")
    if claims.get("email_verified") is False:
        raise IdentityError("Email Google belum terverifikasi.")

    allowed_domains = settings.allowed_google_domains
    if allowed_domains and email:
        domain = email.split("@")[-1].lower()
        if domain not in allowed_domains:
            raise IdentityError("Akun Google harus menggunakan domain institusi yang diizinkan.")

    return VerifiedIdentity(
        subject=str(claims["sub"]),
        email=email,
        name=claims.get("name"),
    )


def resolve_identity(token: Optional[str]) -> Optional[VerifiedIdentity]:
    """Return the verified identity, or None when identity checks are disabled."""
    if not google_auth_required():
        return None
    if not token:
        raise IdentityError("Autentikasi Google diperlukan sebelum mendaftar ujian.")
    return verify_google_id_token(token)
