"""Name normalization rules (spec §6.4)."""
from __future__ import annotations

import pytest

from app.names import clean_display_name, mask_npm, normalize_name


@pytest.mark.parametrize(
    "raw",
    [
        "Alek Nurhabib",
        "alek nurhabib",
        "aleknurhabib",
        "ALeKNurHaBIb",
        "  Alek   Nurhabib  ",
        "ALEK\tNURHABIB",
    ],
)
def test_normalization_matches(raw: str) -> None:
    assert normalize_name(raw) == normalize_name("Alek Nurhabib")


@pytest.mark.parametrize("raw", ["Alek Nurhabip", "Alek Nur Habibi", "Nurhabib Alek", ""])
def test_normalization_rejects(raw: str) -> None:
    assert normalize_name(raw) != normalize_name("Alek Nurhabib")


def test_no_fuzzy_matching_for_typos() -> None:
    # One edited character must not match: no edit distance allowed in v1.3.
    assert normalize_name("Alek Nurhabib") != normalize_name("Alek Nurhablb")


def test_unicode_nfkc_folding() -> None:
    assert normalize_name("Füß") == normalize_name("FÜSS")
    assert normalize_name("Ｊｏｈｎ　Doe") == normalize_name("john doe")


def test_display_name_preserves_roster_casing() -> None:
    assert clean_display_name("  alek   NURHABIB ") == "alek NURHABIB"


def test_mask_npm() -> None:
    assert mask_npm("20210001") == "20****01"
    assert mask_npm("12") == "**"
    assert mask_npm(None) is None
