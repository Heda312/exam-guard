"""Name normalization for participant roster matching (spec §6.4)."""
from __future__ import annotations

import unicodedata


def normalize_name(value: str | None) -> str:
    """Return the normalized comparison key for a name.

    Unicode NFKC -> casefold -> remove all whitespace.
    No fuzzy matching, no edit distance, no typo correction.
    """
    if not value:
        return ""
    normalized = unicodedata.normalize("NFKC", value)
    normalized = normalized.casefold()
    return "".join(normalized.split())


def clean_display_name(value: str | None) -> str:
    """Collapse whitespace for display while preserving the roster casing."""
    if not value:
        return ""
    normalized = unicodedata.normalize("NFKC", value)
    return " ".join(normalized.split())


def mask_npm(npm: str | None) -> str | None:
    """Mask an NPM for participant-facing display (spec §10.2)."""
    if not npm:
        return None
    digits = str(npm)
    if len(digits) <= 3:
        return "*" * len(digits)
    return f"{digits[:2]}{'*' * (len(digits) - 4)}{digits[-2:]}"
