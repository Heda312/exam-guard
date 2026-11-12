"""WebSocket endpoints (spec §19).

Two connection kinds:
- ``/ws/exam/{exam_session_id}``        proctor dashboard (cookie session)
- ``/ws/participant/{participant_id}``  participant page (participant token)

Connection-pool discipline: a WebSocket can live for the whole exam (hours),
but database connections are a scarce pooled resource (~15 by default). Both
handlers therefore finish *all* database work during authentication, close the
session, and only then enter the receive loop. The loop holds no DB connection
at all, so participant count is bounded by memory, not by the pool.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from .database import SessionLocal
from .models import AuthSession, ExamProctor, ExamSession, ParticipantSession, User
from .security import constant_time_equals, hash_token
from .services.exams import ensure_utc, time_remaining_seconds
from .ws import envelope, manager

logger = logging.getLogger(__name__)
router = APIRouter()


def _dumps(payload: dict) -> str:
    """Serialise an envelope, tolerating datetimes anywhere in the payload."""
    return json.dumps(
        payload,
        default=lambda value: value.isoformat() if isinstance(value, datetime) else str(value),
    )


async def _send(websocket: WebSocket, payload: dict) -> None:
    await websocket.send_text(_dumps(payload))


def _auth_session_expired(auth: AuthSession) -> bool:
    expires_at = ensure_utc(auth.expires_at)
    return expires_at <= datetime.now(timezone.utc)


@router.websocket("/ws/exam/{exam_session_id}")
async def exam_socket(
    websocket: WebSocket,
    exam_session_id: str,
    token: Optional[str] = Query(default=None),
) -> None:
    """Proctor monitoring socket. Auth via session cookie, then exam assignment."""
    # Everything below is plain DB work: authenticate, authorize, snapshot the
    # few fields the loop needs, and release the connection.
    connected: Optional[dict] = None
    db = SessionLocal()
    try:
        session_token = websocket.cookies.get("eg_session")
        if not session_token:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        auth = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(session_token)))
        # Revocation *and* expiry are both enforced here; the HTTP layer checks
        # the same, and a dashboard left open overnight must not keep a valid
        # socket after the session dies.
        if auth is None or auth.revoked_at is not None or _auth_session_expired(auth):
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        user = db.get(User, auth.user_id)
        exam_session = db.get(ExamSession, exam_session_id)
        if user is None or not user.is_active or exam_session is None:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        if user.role != "ADMIN":
            assignment = db.scalar(
                select(ExamProctor).where(
                    ExamProctor.exam_id == exam_session.exam_id,
                    ExamProctor.proctor_user_id == user.id,
                    ExamProctor.can_view_exam.is_(True),
                )
            )
            if assignment is None:
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                return

        # Snapshot before closing the DB session.
        connected = {
            "exam_session_id": exam_session_id,
            "status": exam_session.status,
            "started_at": exam_session.started_at,
            "ends_at": exam_session.ends_at,
            "remaining_seconds": time_remaining_seconds(exam_session),
        }
        viewer = {"user_id": user.id, "full_name": user.full_name}
    finally:
        # The connection goes back to the pool before the (potentially
        # hours-long) receive loop starts.
        db.close()

    try:
        await manager.connect_exam(exam_session_id, websocket, viewer=viewer)
        await _send(websocket, envelope("connected", connected))
        await manager.send_to_exam(
            exam_session_id,
            envelope("proctor_presence", {"viewers": manager.exam_viewers(exam_session_id)}),
        )
        try:
            while True:
                message = await websocket.receive_text()
                if message == "ping":
                    await _send(websocket, envelope("pong", {}))
        except WebSocketDisconnect:
            pass
        finally:
            watched_exam_id = await manager.disconnect(websocket)
            if watched_exam_id:
                await manager.send_to_exam(
                    watched_exam_id,
                    envelope("proctor_presence", {"viewers": manager.exam_viewers(watched_exam_id)}),
                )
    except Exception:  # noqa: BLE001 - never leak a traceback to the client
        logger.exception("Proctor socket failed")
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except Exception:  # noqa: BLE001
            pass


@router.websocket("/ws/participant/{participant_session_id}")
async def participant_socket(
    websocket: WebSocket,
    participant_session_id: str,
    token: Optional[str] = Query(default=None),
) -> None:
    """Participant socket. Auth via the participant token query parameter."""
    connected: Optional[dict] = None
    db = SessionLocal()
    try:
        ps = db.get(ParticipantSession, participant_session_id)
        if ps is None or not ps.access_token_hash:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        if not token or not constant_time_equals(hash_token(token), ps.access_token_hash):
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        exam_session = db.get(ExamSession, ps.exam_session_id)
        connected = {
            "participant_session_id": participant_session_id,
            "status": ps.status,
            "ends_at": exam_session.ends_at if exam_session else None,
            "remaining_seconds": time_remaining_seconds(exam_session) if exam_session else 0,
        }
    finally:
        db.close()

    try:
        await manager.connect_participant(participant_session_id, websocket)
        await _send(websocket, envelope("connected", connected))
        try:
            while True:
                message = await websocket.receive_text()
                if message == "ping":
                    await _send(websocket, envelope("pong", {}))
        except WebSocketDisconnect:
            pass
        finally:
            await manager.disconnect(websocket)
    except Exception:  # noqa: BLE001
        logger.exception("Participant socket failed")
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except Exception:  # noqa: BLE001
            pass
