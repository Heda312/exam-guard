"""Exam and participant-session state machines (spec §8.1, §11)."""
from __future__ import annotations

from typing import Dict, FrozenSet

# --- Exam statuses ---------------------------------------------------------
EXAM_STATUSES = (
    "DRAFT",
    "SCHEDULED",
    "REGISTRATION_OPEN",
    "WAITING",
    "STARTING",
    "LIVE",
    "COMPLETED",
    "CANCELLED",
)

EXAM_TRANSITIONS: Dict[str, FrozenSet[str]] = {
    "DRAFT": frozenset({"SCHEDULED", "REGISTRATION_OPEN", "CANCELLED"}),
    "SCHEDULED": frozenset({"REGISTRATION_OPEN", "WAITING", "DRAFT", "CANCELLED"}),
    "REGISTRATION_OPEN": frozenset({"WAITING", "SCHEDULED", "CANCELLED"}),
    "WAITING": frozenset({"STARTING", "CANCELLED", "REGISTRATION_OPEN"}),
    "STARTING": frozenset({"LIVE", "WAITING", "CANCELLED"}),
    "LIVE": frozenset({"COMPLETED"}),
    "COMPLETED": frozenset(),
    "CANCELLED": frozenset(),
}

REGISTRATION_ALLOWED_STATUSES = frozenset({"REGISTRATION_OPEN", "WAITING"})
TERMINAL_EXAM_STATUSES = frozenset({"COMPLETED", "CANCELLED"})


class InvalidTransition(Exception):
    def __init__(self, source: str, target: str) -> None:
        self.source = source
        self.target = target
        super().__init__(f"Transisi status tidak valid: {source} -> {target}")


def assert_exam_transition(source: str, target: str) -> None:
    if target not in EXAM_TRANSITIONS.get(source, frozenset()):
        raise InvalidTransition(source, target)


# --- Participant session statuses -----------------------------------------
PARTICIPANT_STATUSES = (
    "REGISTERED",
    "WAITING",
    "INITIALIZING",
    "READY",
    "MONITORING",
    "CONNECTION_LOST",
    "COMPLETED",
    "TIME_EXPIRED",
    "CANCELLED",
)

# READY is modelled as a transient durable state: the client reports readiness,
# the backend stores READY and then promotes to MONITORING once the extension
# confirms the exam page is verified. Both transitions are explicit so a
# reconnecting client can be told exactly where it is.
PARTICIPANT_TRANSITIONS: Dict[str, FrozenSet[str]] = {
    "REGISTERED": frozenset({"WAITING", "INITIALIZING", "CANCELLED", "TIME_EXPIRED"}),
    "WAITING": frozenset({"INITIALIZING", "CANCELLED", "TIME_EXPIRED", "COMPLETED"}),
    "INITIALIZING": frozenset({"READY", "MONITORING", "CONNECTION_LOST", "TIME_EXPIRED", "CANCELLED"}),
    "READY": frozenset({"MONITORING", "CONNECTION_LOST", "TIME_EXPIRED", "COMPLETED"}),
    "MONITORING": frozenset(
        {"CONNECTION_LOST", "COMPLETED", "TIME_EXPIRED", "CANCELLED", "READY"}
    ),
    "CONNECTION_LOST": frozenset(
        {"MONITORING", "READY", "INITIALIZING", "COMPLETED", "TIME_EXPIRED", "CANCELLED"}
    ),
    "COMPLETED": frozenset(),
    "TIME_EXPIRED": frozenset(),
    "CANCELLED": frozenset(),
}

ACTIVE_PARTICIPANT_STATUSES = frozenset(
    {"REGISTERED", "WAITING", "INITIALIZING", "READY", "MONITORING", "CONNECTION_LOST"}
)
TERMINAL_PARTICIPANT_STATUSES = frozenset({"COMPLETED", "TIME_EXPIRED", "CANCELLED"})


def assert_participant_transition(source: str, target: str) -> None:
    if source == target:
        return
    if target not in PARTICIPANT_TRANSITIONS.get(source, frozenset()):
        raise InvalidTransition(source, target)
