"""Timezone conversion: every human-facing timestamp is Asia/Jakarta (WIB)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.timeutil import (
    EXPORT_DATETIME_FORMAT,
    WIB,
    WIB_LABEL,
    format_wib,
    format_wib_iso,
    now_wib,
    to_wib,
)


def test_wib_is_utc_plus_seven() -> None:
    assert WIB.utcoffset(None) == timedelta(hours=7)
    assert WIB_LABEL == "WIB"


def test_to_wib_converts_from_utc() -> None:
    utc = datetime(2026, 11, 12, 3, 46, 10, tzinfo=timezone.utc)
    converted = to_wib(utc)
    assert converted is not None
    assert converted.hour == 10
    assert converted.minute == 46
    assert converted.utcoffset() == timedelta(hours=7)


def test_to_wib_treats_naive_values_as_utc() -> None:
    """SQLite returns naive datetimes; they are UTC, not local time."""
    naive = datetime(2026, 11, 12, 3, 46, 10)
    converted = to_wib(naive)
    assert converted is not None
    assert converted.hour == 10


def test_to_wib_handles_none() -> None:
    assert to_wib(None) is None


def test_format_wib_appends_the_label() -> None:
    utc = datetime(2026, 11, 12, 3, 46, 10, tzinfo=timezone.utc)
    assert format_wib(utc) == "2026-11-12 10:46:10 WIB"


def test_format_wib_can_omit_the_label() -> None:
    utc = datetime(2026, 11, 12, 3, 46, 10, tzinfo=timezone.utc)
    assert format_wib(utc, with_label=False) == "2026-11-12 10:46:10"
    assert format_wib(None) == ""


def test_format_wib_iso_carries_the_offset() -> None:
    utc = datetime(2026, 11, 12, 3, 46, 10, tzinfo=timezone.utc)
    assert format_wib_iso(utc) == "2026-11-12T10:46:10+07:00"
    assert format_wib_iso(None) == ""


def test_export_format_is_sortable() -> None:
    """YYYY-MM-DD HH:MM:SS sorts lexicographically, which spreadsheets rely on."""
    assert EXPORT_DATETIME_FORMAT == "%Y-%m-%d %H:%M:%S"
    utc = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    assert format_wib(utc, with_label=False).startswith("2026-01-02")


def test_now_wib_is_in_wib() -> None:
    current = now_wib()
    assert current.utcoffset() == timedelta(hours=7)
