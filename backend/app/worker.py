"""Background maintenance: server-authoritative expiry and stale heartbeat sweeps.

The timer is authoritative on the server (spec §12). This worker is the only
component that transitions sessions to TIME_EXPIRED / CONNECTION_LOST.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select

from .config import settings
from .database import SessionLocal
from .models import ExamSession, ParticipantSession, utcnow
from .services.exams import ensure_utc, expire_exam_session, find_expired_sessions
from .services.participants import mark_connection_lost
from .states import TERMINAL_PARTICIPANT_STATUSES
from .ws import envelope, manager

logger = logging.getLogger(__name__)


async def sweep_once() -> None:
    """One maintenance pass. Exposed separately so tests can drive it."""
    db = SessionLocal()
    try:
        # 1. Expire finished exam sessions.
        for exam_session in find_expired_sessions(db):
            expired_participants = expire_exam_session(db, exam_session)
            db.commit()
            logger.info(
                "Exam session %s expired; %d participant session(s) closed",
                exam_session.id,
                len(expired_participants),
            )
            for ps in expired_participants:
                await manager.send_to_participant(
                    ps.id,
                    envelope("time_expired", {"participant_session_id": ps.id, "status": "TIME_EXPIRED"}),
                )
            await manager.send_to_exam(
                exam_session.id,
                envelope("exam_ended", {"exam_session_id": exam_session.id, "status": "COMPLETED"}),
            )

        # 2. Mark silent participants as CONNECTION_LOST (never as cheating).
        threshold = utcnow() - timedelta(seconds=settings.heartbeat_timeout_seconds)
        active = db.scalars(
            select(ParticipantSession).where(
                ParticipantSession.status.in_(["READY", "MONITORING"]),
            )
        ).all()
        for ps in active:
            last = ensure_utc(ps.last_heartbeat_at) or ensure_utc(ps.connected_at)
            if last is None or last > threshold:
                continue
            if manager.is_participant_connected(ps.id):
                # A live socket means the client is reachable even if heartbeats lag.
                continue
            mark_connection_lost(db, ps)
            db.commit()
            exam_session = db.get(ExamSession, ps.exam_session_id)
            if exam_session is not None:
                await manager.send_to_exam(
                    exam_session.id,
                    envelope(
                        "participant_connection_lost",
                        {"participant_session_id": ps.id, "status": ps.status},
                    ),
                )
    except Exception:  # noqa: BLE001 - keep the worker alive
        logger.exception("Maintenance sweep failed")
        db.rollback()
    finally:
        db.close()


async def run_maintenance_loop(stop_event: Optional[asyncio.Event] = None) -> None:
    stop_event = stop_event or asyncio.Event()
    while not stop_event.is_set():
        await sweep_once()
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=settings.expiry_sweep_seconds)
        except asyncio.TimeoutError:
            continue
