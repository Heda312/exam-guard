"""WebSocket endpoints (spec §19).

Two connection kinds:
- ``/ws/exam/{exam_session_id}``        proctor dashboard (cookie session)
- ``/ws/participant/{participant_id}``  participant page (participant token)
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from .database import SessionLocal
from .models import AuthSession, ExamProctor, ExamSession, ParticipantSession, User
from .security import constant_time_equals, hash_token
from .services.exams import time_remaining_seconds
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


@router.websocket("/ws/exam/{exam_session_id}")
async def exam_socket(
    websocket: WebSocket,
    exam_session_id: str,
    token: Optional[str] = Query(default=None),
) -> None:
    """Proctor monitoring socket. Auth via session cookie, then exam assignment."""
    db = SessionLocal()
    try:
        session_token = websocket.cookies.get("eg_session")
        if not session_token:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        auth = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(session_token)))
        if auth is None or auth.revoked_at is not None:
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

        await manager.connect_exam(exam_session_id, websocket)
        await _send(
            websocket,
            envelope(
                "connected",
                {
                    "exam_session_id": exam_session_id,
                    "status": exam_session.status,
                    "started_at": exam_session.started_at,
                    "ends_at": exam_session.ends_at,
                    "remaining_seconds": time_remaining_seconds(exam_session),
                },
            ),
        )
        try:
            while True:
                message = await websocket.receive_text()
                if message == "ping":
                    await _send(websocket, envelope("pong", {}))
        except WebSocketDisconnect:
            pass
        finally:
            await manager.disconnect(websocket)
    except Exception:  # noqa: BLE001 - never leak a traceback to the client
        logger.exception("Proctor socket failed")
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except Exception:  # noqa: BLE001
            pass
    finally:
        db.close()


@router.websocket("/ws/participant/{participant_session_id}")
async def participant_socket(
    websocket: WebSocket,
    participant_session_id: str,
    token: Optional[str] = Query(default=None),
) -> None:
    """Participant socket. Auth via the participant token query parameter."""
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
        await manager.connect_participant(participant_session_id, websocket)
        await _send(
            websocket,
            envelope(
                "connected",
                {
                    "participant_session_id": participant_session_id,
                    "status": ps.status,
                    "ends_at": exam_session.ends_at if exam_session else None,
                    "remaining_seconds": time_remaining_seconds(exam_session) if exam_session else 0,
                },
            ),
        )
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
    finally:
        db.close()
