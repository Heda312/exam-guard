"""Timezone helpers.

Every timestamp the API stores is UTC. Everything a human reads — dashboards,
CSV, XLSX — must be Asia/Jakarta (WIB, UTC+7). Centralising the conversion keeps
those two worlds from drifting apart.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

# Indonesia has no daylight saving time, so a fixed offset is correct and avoids
# depending on a tzdata package being installed in the container.
WIB = timezone(timedelta(hours=7), name="WIB")

WIB_LABEL = "WIB"

# Display format used in exports: 2026-11-12 10:46:10 WIB
EXPORT_DATETIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def to_wib(value: Optional[datetime]) -> Optional[datetime]:
    """Convert an aware/naive-UTC datetime to Asia/Jakarta."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(WIB)


def format_wib(value: Optional[datetime], *, with_label: bool = True) -> str:
    """Human-readable WIB timestamp, or an empty string when there is no value."""
    converted = to_wib(value)
    if converted is None:
        return ""
    text = converted.strftime(EXPORT_DATETIME_FORMAT)
    return f"{text} {WIB_LABEL}" if with_label else text


def format_wib_iso(value: Optional[datetime]) -> str:
    """ISO-8601 WIB timestamp, e.g. 2026-11-12T10:46:10+07:00."""
    converted = to_wib(value)
    if converted is None:
        return ""
    return converted.isoformat()


def now_wib() -> datetime:
    return datetime.now(WIB)
