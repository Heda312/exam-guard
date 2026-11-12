from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app import ws_routes
from app.api import participant as participant_api
from app.api.participant import _authorize, _session_out
from app.database import SessionLocal, engine
from app.models import AuthSession, ExamSession, ParticipantSession, utcnow
from app.security import hash_token

from .helpers import add_participant, create_exam, register_participant


def _session(admin_client: TestClient):
    exam = create_exam(admin_client)
    add_participant(admin_client, exam['id'], 'Peserta WebSocket')
    code, participant, token = register_participant(admin_client, exam['exam_code'], 'Peserta WebSocket')
    assert code == 201
    exam = admin_client.get(f"/api/v1/exams/{exam['id']}").json()
    return exam, participant['participant_session_id'], token


@pytest.mark.parametrize('kind', ['exam', 'participant', 'heartbeat'])
def test_pool_wait_does_not_block_http(admin_client, monkeypatch, kind):
    exam, ps, token = _session(admin_client)
    entered = threading.Event()
    released = threading.Event()
    quit_socket = threading.Event()

    class TrackingSession(SessionLocal.class_):
        def __enter__(self):
            entered.set()
            return super().__enter__()

    monkeypatch.setattr(ws_routes, 'SessionLocal', lambda: TrackingSession(bind=engine))
    heartbeat_state = participant_api._heartbeat_state

    def tracked_heartbeat(*args):
        entered.set()
        return heartbeat_state(*args)

    monkeypatch.setattr(participant_api, '_heartbeat_state', tracked_heartbeat)
    connections = [engine.connect() for _ in range(engine.pool.size() + engine.pool._max_overflow)]
    path = f"/ws/exam/{exam['exam_session_id']}" if kind == 'exam' else f'/ws/participant/{ps}?token={token}'

    def connect():
        if kind == 'heartbeat':
            response = admin_client.post('/api/v1/participant/heartbeat', json={'participant_session_id': ps}, headers={'X-Participant-Token': token})
            assert response.status_code == 200
            assert released.wait(3)
            assert engine.pool.checkedout() == 0
            return
        with admin_client.websocket_connect(path) as socket:
            frame = socket.receive_json()
            assert frame['event'] == 'connected'
            socket.send_text('ping')
            while socket.receive_json()['event'] != 'pong':
                pass
            assert released.wait(3)
            assert engine.pool.checkedout() == 0
            quit_socket.wait(5)

    def release():
        for connection in connections:
            connection.close()
        released.set()

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(connect)
        assert entered.wait(3)
        timer = threading.Timer(1, release)
        timer.start()
        try:
            start = time.perf_counter()
            response = admin_client.get('/health')
            elapsed = time.perf_counter() - start
            assert response.status_code == 200
            assert elapsed < 0.5
        finally:
            timer.cancel()
            release()
            quit_socket.set()
        future.result(timeout=5)


@pytest.mark.parametrize('participant_status', ['MONITORING', 'COMPLETED', 'TIME_EXPIRED', 'CANCELLED'])
def test_expired_heartbeat_releases_connection_before_notification(admin_client, monkeypatch, participant_status):
    exam, ps, token = _session(admin_client)
    assert admin_client.post(f"/api/v1/exams/{exam['id']}/start").status_code == 200
    with SessionLocal() as db:
        db.get(ExamSession, exam['exam_session_id']).ends_at = utcnow() - timedelta(seconds=5)
        db.get(ParticipantSession, ps).status = participant_status
        db.commit()
    notifications = []

    async def send(participant_session_id, message):
        assert engine.pool.checkedout() == 0
        notifications.append((participant_session_id, message))

    monkeypatch.setattr(participant_api.manager, 'send_to_participant', send)
    response = admin_client.post('/api/v1/participant/heartbeat', json={'participant_session_id': ps}, headers={'X-Participant-Token': token})
    assert response.status_code == 200
    expected_status = 'TIME_EXPIRED' if participant_status == 'MONITORING' else participant_status
    assert response.json()['status'] == expected_status
    assert response.json()['remaining_seconds'] == 0
    if participant_status == 'MONITORING':
        assert len(notifications) == 1
        assert notifications[0][0] == ps
        assert notifications[0][1]['event'] == 'time_expired'
    else:
        assert notifications == []
    with SessionLocal() as db:
        assert db.get(ParticipantSession, ps).status == participant_status


@pytest.mark.parametrize('token_kind', ['missing', 'wrong'])
def test_heartbeat_rejects_invalid_token_and_releases_connection(admin_client, token_kind):
    _, ps, _ = _session(admin_client)
    headers = {'X-Participant-Token': 'wrong-token'} if token_kind == 'wrong' else {}
    response = admin_client.post('/api/v1/participant/heartbeat', json={'participant_session_id': ps}, headers=headers)
    assert response.status_code == 403
    assert engine.pool.checkedout() == 0


@pytest.mark.parametrize('token_kind', ['missing', 'wrong'])
def test_participant_socket_rejects_invalid_token(admin_client, token_kind):
    _, ps, _ = _session(admin_client)
    query = '?token=wrong-token' if token_kind == 'wrong' else ''
    with pytest.raises(WebSocketDisconnect) as exc:
        with admin_client.websocket_connect(f'/ws/participant/{ps}{query}'):
            pass
    assert exc.value.code == 1008


@pytest.mark.parametrize('auth_state', ['expired', 'revoked'])
def test_exam_socket_rejects_inactive_auth(admin_client, db, auth_state):
    exam, _, _ = _session(admin_client)
    auth = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(admin_client.cookies.get('eg_session'))))
    if auth_state == 'expired':
        auth.expires_at = utcnow() - timedelta(seconds=1)
    else:
        auth.revoked_at = utcnow()
    db.commit()
    with pytest.raises(WebSocketDisconnect) as exc:
        with admin_client.websocket_connect(f"/ws/exam/{exam['exam_session_id']}"):
            pass
    assert exc.value.code == 1008


@pytest.mark.parametrize('can_view', [None, False, True])
def test_proctor_socket_requires_view_assignment(admin_client, can_view):
    exam, _, _ = _session(admin_client)
    response = admin_client.post('/api/v1/admin/proctors', json={
        'username': 'socket-proctor', 'full_name': 'Proktor WebSocket', 'password': 'ProktorRahasia123',
    })
    assert response.status_code == 201
    if can_view is not None:
        assignment = admin_client.post(f"/api/v1/admin/exams/{exam['id']}/proctors", json={
            'proctor_user_id': response.json()['id'], 'permissions': {'can_view_exam': can_view},
        })
        assert assignment.status_code == 201
    admin_client.post('/api/v1/auth/logout')
    login = admin_client.post('/api/v1/auth/login', json={'username': 'socket-proctor', 'password': 'ProktorRahasia123'})
    assert login.status_code == 200
    path = f"/ws/exam/{exam['exam_session_id']}"
    if can_view:
        with admin_client.websocket_connect(path) as socket:
            assert socket.receive_json()['event'] == 'connected'
    else:
        with pytest.raises(WebSocketDisconnect) as exc:
            with admin_client.websocket_connect(path):
                pass
        assert exc.value.code == 1008


def test_participant_response_releases_read_connection(admin_client):
    _, ps, token = _session(admin_client)
    with SessionLocal() as db:
        participant = _authorize(db, ps, token)
        assert engine.pool.checkedout() == 1
        response = _session_out(db, participant)
        assert response.participant_session_id == ps
        assert response.participant['full_name'] == 'Peserta WebSocket'
        assert engine.pool.checkedout() == 0
