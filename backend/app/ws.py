"""Realtime connection manager for WebSocket fan-out.

Participants and proctors connect to ``/ws``. The manager keeps the mapping
from participant session id / exam session id to live sockets and provides
small helpers for the events defined in spec §19.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, DefaultDict, Dict, Iterable, Optional, Set

from fastapi import WebSocket

logger = logging.getLogger(__name__)


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


class ConnectionManager:
    def __init__(self) -> None:
        self._participants: Dict[str, Set[WebSocket]] = defaultdict(set)
        self._exams: Dict[str, Set[WebSocket]] = defaultdict(set)
        # exam_session_id -> socket -> viewer identity (proctor/admin dashboard)
        self._exam_viewers: DefaultDict[str, Dict[WebSocket, Dict[str, str]]] = defaultdict(dict)
        self._lock = asyncio.Lock()

    async def connect_participant(self, participant_session_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._participants[participant_session_id].add(websocket)

    async def connect_exam(
        self,
        exam_session_id: str,
        websocket: WebSocket,
        viewer: Optional[Dict[str, str]] = None,
    ) -> None:
        await websocket.accept()
        async with self._lock:
            self._exams[exam_session_id].add(websocket)
            if viewer is not None:
                self._exam_viewers[exam_session_id][websocket] = viewer

    async def disconnect(self, websocket: WebSocket) -> Optional[str]:
        """Remove a socket; return the exam session id if it was a tracked viewer."""
        async with self._lock:
            for bucket in list(self._participants.values()):
                bucket.discard(websocket)
            for bucket in list(self._exams.values()):
                bucket.discard(websocket)
            for exam_session_id, viewers in list(self._exam_viewers.items()):
                if websocket in viewers:
                    del viewers[websocket]
                    return exam_session_id
        return None

    async def _send_many(self, sockets: Iterable[WebSocket], payload: dict[str, Any]) -> None:
        message = json.dumps(payload, default=_json_default)
        for socket in list(sockets):
            try:
                await socket.send_text(message)
            except Exception:  # pragma: no cover - socket already gone
                await self.disconnect(socket)

    async def send_to_participant(self, participant_session_id: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            sockets = list(self._participants.get(participant_session_id, ()))
        await self._send_many(sockets, payload)

    async def send_to_exam(self, exam_session_id: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            sockets = list(self._exams.get(exam_session_id, ()))
        await self._send_many(sockets, payload)

    def participant_connection_count(self, participant_session_id: str) -> int:
        return len(self._participants.get(participant_session_id, ()))

    def is_participant_connected(self, participant_session_id: str) -> bool:
        return self.participant_connection_count(participant_session_id) > 0

    def exam_viewers(self, exam_session_id: str) -> list[Dict[str, str]]:
        """Distinct staff identities currently holding a dashboard socket."""
        distinct: Dict[str, Dict[str, str]] = {}
        for viewer in self._exam_viewers.get(exam_session_id, {}).values():
            distinct.setdefault(viewer["user_id"], viewer)
        return list(distinct.values())


manager = ConnectionManager()


def envelope(event: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "event": event,
        "server_time": datetime.now(timezone.utc).isoformat(),
        "data": data,
    }
