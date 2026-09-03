"""
voice_bff.py — Standalone BFF relay for the voice channel: browser <-> BFF <-> Voice Backend.

This is a self-contained FastAPI app. It does NOT import from bff.py, router/auth.py,
utils/utils.py, or any models/ module — there is no session store and no OBO/token
acquisition here. The three delegated tokens (backend_token, foundry_token,
speech_token) are HARDCODED below as placeholders for now; replace them with real
values before running. This is a deliberate, temporary simplification — swap the
hardcoded constants for real per-user token acquisition later without touching
anything else in this file.

Flow:
    Frontend (index.html) --ws--> voice_bff.py (this file) --ws--> main_merged.py (/chat)

    1. Browser opens a WebSocket to this BFF's /voice/chat.
    2. Browser's first frame MUST be {"type": "init", "session_id": "<uuid>"} — the
       frontend generates this uuid itself (crypto.randomUUID()) once per new
       connection.
    3. This BFF opens its OWN outbound WebSocket connection to the Voice Backend's
       /chat endpoint, attaching the (hardcoded) tokens as headers — exactly the
       "non-browser client" header-auth path main_merged.py already supports — plus
       X-Session-Id so the backend uses the frontend's id instead of minting its own.
    4. From then on, this BFF is a transparent duplex relay: every frame from the
       browser (binary PCM16 audio, JSON control messages like start_listening /
       stop_listening / playback_started / playback_ended) is forwarded byte-for-byte
       to the backend, and every frame from the backend (session_ready, status,
       user_text, agent_text, agent_audio, consent, error, pong) is forwarded
       byte-for-byte back to the browser. Nothing is inspected or re-serialized, so
       barge-in, perceived-latency filler, and consent handling all keep working
       exactly as they do talking to main_merged.py directly.

Install:
    pip install fastapi "uvicorn[standard]" websockets

Run:
    uvicorn voice_bff:app --host 0.0.0.0 --port 8000 --reload

Then point index.html's connection URL at:
    ws://localhost:8000/voice/chat   (plain ws:// for local dev — no TLS is set up
                                       on this BFF, so wss:// will NOT work here)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Optional

import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from websockets.exceptions import ConnectionClosed

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("voice-bff")

# --------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------

# Base ws(s):// URL of the existing Voice Backend (main_merged.py). Must use the
# ws:// / wss:// scheme, NOT http(s)://.
BACKEND_URL_VOICE = os.environ.get("BACKEND_URL_VOICE", "ws://localhost:3001")

ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

# How long to wait for the frontend's first {"type":"init","session_id":...} frame
# before giving up.
INIT_HANDSHAKE_TIMEOUT_S = float(os.environ.get("INIT_HANDSHAKE_TIMEOUT_S", "10"))

# Cap on a single relayed frame (audio chunks are small; agent_audio/base64 mp3 clips
# are the biggest frames).
MAX_RELAY_FRAME_BYTES = int(os.environ.get("MAX_RELAY_FRAME_BYTES", str(20 * 1024 * 1024)))

# --------------------------------------------------------------------------------------
# HARDCODED TOKENS — placeholders. Replace with real Entra access tokens before
# running. These are used for EVERY connection this BFF relays (no per-user
# resolution yet).
#   * BACKEND_TOKEN — access token for main_merged.py's own API (aud = its
#                     BACKEND_API_AUDIENCE), must carry the "access_as_user" scope.
#   * FOUNDRY_TOKEN — delegated token for Microsoft Foundry (aud = https://ai.azure.com)
#   * SPEECH_TOKEN  — delegated token for Cognitive Services
#                     (aud = https://cognitiveservices.azure.com)
# --------------------------------------------------------------------------------------

BACKEND_TOKEN = os.getenv("BACKEND_TOKEN", "")
FOUNDRY_TOKEN = os.getenv("FOUNDRY_TOKEN", "")
SPEECH_TOKEN = os.getenv("SPEECH_TOKEN", "")

# --------------------------------------------------------------------------------------
# FastAPI app — standalone, no other project files imported.
# --------------------------------------------------------------------------------------

app = FastAPI(
    title="Voice BFF",
    version="1.0.0",
    description="Standalone WebSocket relay: browser <-> BFF <-> Voice Backend.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


async def _send_json_safe(ws: WebSocket, payload: dict) -> None:
    try:
        await ws.send_json(payload)
    except Exception:
        pass


async def _receive_init_session_id(websocket: WebSocket) -> Optional[str]:
    """Waits for the frontend's first frame, which MUST be
    {"type": "init", "session_id": "<uuid the frontend generated for this new
    session>"}. Returns the session_id, or None if the frame is missing/malformed."""
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
    """Returns a websockets.connect(...) async context manager, targeting the
    installed `websockets` library's actual API.

    The `websockets` package renamed this connect() kwarg from `extra_headers` to
    `additional_headers` in v14 (the new asyncio-based client implementation) — and
    passing the wrong one raises TypeError at call time (not import time), which is
    exactly the error this works around. We introspect the real client callable's
    signature once and pick whichever kwarg it actually accepts, so this keeps
    working regardless of which `websockets` version is installed, with no need to
    pin a specific release."""
    import inspect

    try:
        params = inspect.signature(websockets.connect).parameters
    except (TypeError, ValueError):
        params = {}

    if "additional_headers" in params:
        return websockets.connect(
            url,
            additional_headers=headers,
            max_size=MAX_RELAY_FRAME_BYTES,
            ping_interval=20,
            ping_timeout=20,
        )
    if "extra_headers" in params:
        return websockets.connect(
            url,
            extra_headers=headers,
            max_size=MAX_RELAY_FRAME_BYTES,
            ping_interval=20,
            ping_timeout=20,
        )
    # Neither kwarg detected (very old/very new unexpected API) — try
    # additional_headers first, since that's the current stable name, and let it
    # raise naturally if it's genuinely unsupported.
    return websockets.connect(
        url,
        additional_headers=headers,
        max_size=MAX_RELAY_FRAME_BYTES,
        ping_interval=20,
        ping_timeout=20,
    )


async def _pump_client_to_upstream(client_ws: WebSocket, upstream_ws) -> None:
    """Copies every frame the BROWSER sends (binary PCM16 audio chunks, and JSON
    control messages) straight through to the Voice Backend, unmodified."""
    while True:
        message = await client_ws.receive()

        if message["type"] == "websocket.disconnect":
            break

        if message.get("bytes") is not None:
            await upstream_ws.send(message["bytes"])
        elif message.get("text") is not None:
            await upstream_ws.send(message["text"])


async def _pump_upstream_to_client(client_ws: WebSocket, upstream_ws) -> None:
    """Copies every frame the Voice Backend sends straight through to the browser,
    unmodified."""
    async for message in upstream_ws:
        if isinstance(message, (bytes, bytearray)):
            await client_ws.send_bytes(message)
        else:
            await client_ws.send_text(message)


@app.websocket("/voice/chat")
async def voice_chat_relay(websocket: WebSocket) -> None:
    await websocket.accept()

    # ---- Resolve the session_id the FRONTEND generated for this new session ------
    session_id = await _receive_init_session_id(websocket)
    if not session_id:
        await _send_json_safe(websocket, {
            "type": "error",
            "message": "expected first frame {\"type\":\"init\",\"session_id\":\"...\"}",
        })
        await websocket.close(code=1008)  # policy violation
        return

    # ---- Open our own outbound connection to the Voice Backend -------------------
    # Hardcoded tokens forwarded as headers — the same non-browser, header-based auth
    # path main_merged.py already supports — plus X-Session-Id so the backend uses
    # OUR id instead of minting its own.
    backend_ws_url = f"{BACKEND_URL_VOICE.rstrip('/')}/chat"
    upstream_headers = {
        "Authorization": f"Bearer {BACKEND_TOKEN}",
        "X-Foundry-Token": FOUNDRY_TOKEN,
        "X-Speech-Token": SPEECH_TOKEN,
        "X-Session-Id": session_id,
    }

    log.info("[%s] relaying to voice backend at %s", session_id, backend_ws_url)

    try:
        async with _open_upstream_connection(backend_ws_url, upstream_headers) as upstream_ws:
            client_to_upstream = asyncio.create_task(_pump_client_to_upstream(websocket, upstream_ws))
            upstream_to_client = asyncio.create_task(_pump_upstream_to_client(websocket, upstream_ws))

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

            # Surface a real failure from whichever pump finished first, so it isn't
            # silently swallowed (a clean disconnect just finishes with no exception).
            for task in done:
                exc = task.exception()
                if exc is not None and not isinstance(exc, (WebSocketDisconnect, ConnectionClosed)):
                    raise exc

    except (WebSocketDisconnect, ConnectionClosed):
        pass
    except Exception as error:
        log.exception("[%s] voice BFF relay error", session_id)
        await _send_json_safe(websocket, {
            "type": "error",
            "message": f"voice backend relay failed: {error}",
        })
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
        log.info("[%s] voice BFF relay closed", session_id)
