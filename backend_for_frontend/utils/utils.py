import jwt
import secrets
import httpx
from fastapi import HTTPException, Request, WebSocket
from utils.nr_logger import NewRelicLogger


def decode_jwt_token(token: str):
    try:
        decoded_details = jwt.decode(
            token,
            options={'verify_signature': False}
        )
        return decoded_details
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {error}"
        )


def create_session():
    session_id = secrets.token_urlsafe(32)
    return session_id


# ---------------------------------------------------------------------------
# New Relic logging helpers
# ---------------------------------------------------------------------------
def get_logger(request: Request) -> NewRelicLogger:
    """FastAPI dependency: hand routers the single shared logger from app.state.

    HTTP ROUTES ONLY. Do NOT use this on a @router.websocket(...) endpoint —
    FastAPI cannot resolve a `Request` object in a WebSocket scope. Use
    get_ws_logger() below instead for websocket routes (router/voice_chat.py)."""
    return request.app.state.logger


def get_ws_logger(websocket: WebSocket) -> NewRelicLogger:
    """WebSocket-safe equivalent of get_logger(), for use with
    @router.websocket(...) endpoints (router/voice_chat.py). A websocket
    route must depend on `WebSocket`, never `Request`, or the dependency
    fails to resolve at connect time (this previously broke the Connect
    button)."""
    return websocket.app.state.logger


# ---------------------------------------------------------------------------
# Shared, pooled HTTP client dependency
# ---------------------------------------------------------------------------
def get_http_client(request: Request) -> httpx.AsyncClient:
    """
    FastAPI dependency: hand routers the single shared, pooled httpx.AsyncClient
    created once in main.py's lifespan (app.state.http_client). Avoids
    router/text_chat.py opening (and tearing down) a brand-new TCP/TLS
    connection to the backend on every single /chat and /chatV1 call.
    """
    return request.app.state.http_client


def user_from_session(session) -> dict:
    """
    Best-effort extraction of user identity so every log line carries
    user_oid / user_name (same fields as the backend). Never raises.
    """
    info = {"user_oid": None, "user_name": None}
    try:
        if session and getattr(session, "sso_token", None):
            claims = decode_jwt_token(session.sso_token.get("user_token"))
            info["user_oid"] = claims.get("oid")
            info["user_name"] = claims.get("name") or claims.get("preferred_username")
    except Exception:
        pass
    return info


# ---------------------------------------------------------------------------
# Error taxonomy — keeps BFF-level failures distinguishable from backend ones
# ---------------------------------------------------------------------------
def classify_status(status: int) -> str:
    if status in (401, 403):
        return "auth_error"
    if status == 404:
        return "not_found"
    if status == 422:
        return "validation_error"
    if status == 429:
        return "rate_limited"
    if status in (502, 503, 504):
        return "upstream_error"
    if 400 <= status < 500:
        return "client_error"
    return "bff_server_error"


_FRIENDLY = {
    "auth_error": "Authentication or authorization failed.",
    "not_found": "The requested resource was not found.",
    "validation_error": "The request payload was invalid.",
    "rate_limited": "The service is busy. Please retry shortly.",
    "upstream_error": "A downstream service is temporarily unavailable.",
    "client_error": "The request could not be completed.",
    "backend_error": "The backend service returned an error.",
    "bff_proxy_error": "The BFF could not reach the backend service.",
    "bff_server_error": "An unexpected error occurred in the BFF.",
}


def friendly_message(category: str) -> str:
    return _FRIENDLY.get(category, "An error occurred.")
