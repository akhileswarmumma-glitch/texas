"""
voice_bff.py — Standalone BFF relay for the voice channel: browser <-> BFF <-> Voice Backend.

IMPORTANT — WebSocket-safe dependency: this route uses `Depends(get_ws_logger)`,
NOT `Depends(get_logger)` — get_logger() requires a `Request` object, which
does not exist on a WebSocket connection.

Graceful scale-in: main.py's GracefulWebSocketProtocol keeps this
connection alive across a SIGTERM (scale-in / redeploy) instead of letting
Uvicorn force-close it. ADDED in this file: a background watcher task that
notices when that SIGTERM happened (via the shared `scale_in_event` on
app.state, set by main.py) and pushes ONE custom "notice" message down this
WebSocket so the frontend can display it -- purely informational, the relay
itself is completely unaffected and keeps running exactly as before.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import time
import traceback
import uuid
from typing import Optional

import websockets
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from websockets.exceptions import ConnectionClosed

from backend_for_frontend.router.auth import get_current_session
from utils.utils import get_ws_logger, user_from_session

BACKEND_URL_VOICE = os.environ.get("BACKEND_URL_VOICE", "ws://localhost:3001")
INIT_HANDSHAKE_TIMEOUT_S = float(os.environ.get("INIT_HANDSHAKE_TIMEOUT_S", "10"))
MAX_RELAY_FRAME_BYTES = int(os.environ.get("MAX_RELAY_FRAME_BYTES", str(20 * 1024 * 1024)))

router = APIRouter(prefix="/voice", tags=["Voice Chat"])


async def _send_json_safe(ws: WebSocket, payload: dict) -> None:
    try:
        await ws.send_json(payload)
    except Exception:
        pass


async def _receive_init_session_id(websocket: WebSocket) -> Optional[str]:
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=INIT_HANDSHAKE_TIMEOUT_S)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        return None
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if msg.get("type") != "init":
        return None
    session_id = (msg.get("session_id") or "").strip()
    return session_id or None


def _open_upstream_connection(url: str, headers: dict):
    try:
        params = inspect.signature(websockets.connect).parameters
    except (TypeError, ValueError):
        params = {}
    if "additional_headers" in params:
        return websockets.connect(
            url, additional_headers=headers, max_size=MAX_RELAY_FRAME_BYTES,
            ping_interval=20, ping_timeout=20,
        )
    if "extra_headers" in params:
        return websockets.connect(
            url, extra_headers=headers, max_size=MAX_RELAY_FRAME_BYTES,
            ping_interval=20, ping_timeout=20,
        )
    return websockets.connect(
        url, additional_headers=headers, max_size=MAX_RELAY_FRAME_BYTES,
        ping_interval=20, ping_timeout=20,
    )


async def _pump_client_to_upstream(client_ws: WebSocket, upstream_ws, counters: dict) -> None:
    while True:
        message = await client_ws.receive()
        if message["type"] == "websocket.disconnect":
            break
        if message.get("bytes") is not None:
            await upstream_ws.send(message["bytes"])
            counters["client_frames"] += 1
        elif message.get("text") is not None:
            await upstream_ws.send(message["text"])
            counters["client_frames"] += 1


async def _pump_upstream_to_client(client_ws: WebSocket, upstream_ws, counters: dict) -> None:
    async for message in upstream_ws:
        if isinstance(message, (bytes, bytearray)):
            await client_ws.send_bytes(message)
        else:
            await client_ws.send_text(message)
        counters["backend_frames"] += 1


# ---------------------------------------------------------------------------
# ADDED: scale-in notice watcher.
#
# Waits on the shared `scale_in_event` (set once, in main.py's
# GracefulWebSocketProtocol.shutdown(), the moment this worker process
# receives SIGTERM). The instant it fires, sends ONE best-effort "notice"
# frame to the browser and logs that it did so, then returns -- it does NOT
# touch the relay pumps or affect connection lifecycle in any way. Runs as
# an independent background task, deliberately NOT included in the
# asyncio.wait({...}, return_when=FIRST_COMPLETED) set below, so it finishing
# is never mistaken for "the connection ended."
# ---------------------------------------------------------------------------
async def _watch_scale_in(
    websocket: WebSocket,
    request_id: str,
    session_id: str,
    user_info: dict,
    logger,
) -> None:
    scale_in_event = getattr(websocket.app.state, "scale_in_event", None)
    if scale_in_event is None:
        return  # defensive only -- main.py's lifespan always sets this
    await scale_in_event.wait()

    from main import SCALE_IN_NOTICE_MESSAGE  # see note below on this import

    logger.log({
        "event": "bff_voice_scale_in_notified",
        "request_id": request_id,
        "session_id": session_id,
        "display_message": SCALE_IN_NOTICE_MESSAGE,
        **user_info,
    })
    await _send_json_safe(websocket, {
        "type": "notice",
        "code": "scale_in",
        "message": SCALE_IN_NOTICE_MESSAGE,
    })


@router.websocket("/chat")
async def voice_chat_relay(
    websocket: WebSocket,
    session=Depends(get_current_session),
    logger=Depends(get_ws_logger),
) -> None:
    request_id = websocket.headers.get("x-request-id") or str(uuid.uuid4())
    user_info = user_from_session(session)

    try:
        backend_token = session.sso_token["user_token"]
        foundry_token = session.sso_token["foundry_token"]
        speech_token = session.sso_token["speech_token"]
    except Exception as token_err:
        logger.log({
            "event": "bff_voice_auth_error",
            "request_id": request_id,
            "error": f"{type(token_err).__name__}: {token_err}",
            "error_category": "auth_error",
            "display_message": "Voice session tokens missing or malformed.",
            **user_info,
        })
        await websocket.close(code=1008)
        return

    await websocket.accept()
    start_time = time.perf_counter()

    session_id = await _receive_init_session_id(websocket)
    if not session_id:
        logger.log({
            "event": "bff_voice_init_failed",
            "request_id": request_id,
            "error": "handshake timeout or malformed init frame",
            "error_category": "client_error",
            "display_message": "Voice session did not complete its init handshake.",
            **user_info,
        })
        await _send_json_safe(websocket, {
            "type": "error",
            "message": "expected first frame {\"type\":\"init\",\"session_id\":\"...\"}",
        })
        await websocket.close(code=1008)
        return

    backend_ws_url = f"{BACKEND_URL_VOICE.rstrip('/')}/chat"
    upstream_headers = {
        # "Authorization": f"Bearer {backend_token}",
        # "X-Foundry-Token": foundry_token,
        # "X-Speech-Token": speech_token,
        # "X-Session-Id": session_id,
    }


    logger.log({
        "event": "bff_voice_session_started",
        "request_id": request_id,
        "session_id": session_id,
        "backend_url": backend_ws_url,
        **user_info,
    })

    # ADDED: start the scale-in watcher as soon as we have a session_id,
    # so it's active for the entire lifetime of the relay below.
    scale_in_watcher = asyncio.create_task(
        _watch_scale_in(websocket, request_id, session_id, user_info, logger)
    )

    counters = {"client_frames": 0, "backend_frames": 0}
    end_reason = "unknown"
    upstream_cm = _open_upstream_connection(backend_ws_url, upstream_headers)

    try:
        try:
            upstream_ws = await upstream_cm.__aenter__()
            await upstream_ws.send(
                json.dumps({
                    "type": "auth",
                    "backend_token": backend_token,
                    "foundry_token": foundry_token,
                    "speech_token": speech_token,
                    "session_id": session_id,
                })
            )
        except Exception as connect_err:
            logger.log({
                "event": "bff_voice_upstream_connect_error",
                "request_id": request_id,
                "session_id": session_id,
                "error": f"{type(connect_err).__name__}: {connect_err}",
                "error_category": "bff_proxy_error",
                "display_message": "The BFF could not reach the voice backend.",
                "backend_url": backend_ws_url,
                **user_info,
            })
            await _send_json_safe(websocket, {
                "type": "error",
                "message": f"could not reach voice backend: {connect_err}",
            })
            await websocket.close(code=1011)
            return

        try:
            client_to_upstream = asyncio.create_task(
                _pump_client_to_upstream(websocket, upstream_ws, counters)
            )
            upstream_to_client = asyncio.create_task(
                _pump_upstream_to_client(websocket, upstream_ws, counters)
            )
            done, pending = await asyncio.wait(
                {client_to_upstream, upstream_to_client},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in pending:
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
            end_reason = (
                "client_disconnected" if client_to_upstream in done else "backend_disconnected"
            )
            for task in done:
                exc = task.exception()
                if exc is not None and not isinstance(exc, (WebSocketDisconnect, ConnectionClosed)):
                    raise exc
        finally:
            await upstream_cm.__aexit__(None, None, None)

    except (WebSocketDisconnect, ConnectionClosed):
        end_reason = end_reason if end_reason != "unknown" else "disconnected"
    except Exception as error:
        end_reason = "error"
        logger.log({
            "event": "bff_voice_relay_error",
            "request_id": request_id,
            "session_id": session_id,
            "error": f"{type(error).__name__}: {error}",
            "traceback": traceback.format_exc()[:6000],
            "error_category": "bff_server_error",
            "display_message": "An unexpected error occurred during the voice relay.",
            **user_info,
        })
        await _send_json_safe(websocket, {
            "type": "error",
            "message": f"voice backend relay failed: {error}",
        })
    finally:
        # ADDED: stop the scale-in watcher along with everything else ending.
        scale_in_watcher.cancel()
        try:
            await scale_in_watcher
        except (asyncio.CancelledError, Exception):
            pass

        logger.log({
            "event": "bff_voice_session_ended",
            "request_id": request_id,
            "session_id": session_id,
            "end_reason": end_reason,
            "duration_ms": round((time.perf_counter() - start_time) * 1000, 2),
            "client_frames_relayed": counters["client_frames"],
            "backend_frames_relayed": counters["backend_frames"],
            **user_info,
        })
        try:
            await websocket.close()
        except Exception:
            pass
