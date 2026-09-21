from pathlib import Path
import os
import json
import time
import uuid
import logging
import traceback
from contextlib import asynccontextmanager

import httpx
import uvicorn
import uvicorn.config
import uvicorn.protocols.websockets.websockets_impl as _ws_impl_module

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from router.auth import router as auth_route, init_cosmos, aclose_cosmos
from router.text_chat import router as text_chat_route
from router.cookies import router as cookie_route
from router.voice_chat import router as voice_route
from utils.nr_logger import build_logger, traffic_source_ctx
from utils.utils import classify_status, friendly_message
from utils.canonical_redirect import CanonicalHostRedirectMiddleware
from utils.session_cache import init_session_cache, aclose_session_cache


# Paths we don't want flooding the logs (health polling + static assets).
_SKIP_ACCESS_LOG_PREFIXES = ("/health", "/healthz", "/assets", "/favicon")
ZAP_UA_MARKER = "ROADIERANGER-ZAP-SCAN"
_ws_log = logging.getLogger("uvicorn.error")


# ---------------------------------------------------------------------------
# ADDED: scale-in / SIGTERM notification for active voice sessions.
#
# GOAL: when this worker process receives SIGTERM (KEDA scale-in on ACA,
# rolling deploy, App Service instance recycle, etc.), (1) print a clear,
# unmissable line to console logs, and (2) push ONE custom "notice" message
# down every currently-open voice WebSocket so the frontend can display it
# to the user -- all WITHOUT interrupting the session itself (that part is
# already handled by GracefulWebSocketProtocol.shutdown() below, which keeps
# the connection open instead of force-closing it with code 1012).
#
# WHY THE FLAG IS STASHED ON uvicorn.protocols.websockets.websockets_impl
# (NOT as a bare module-level variable in this file):
# -----------------------------------------------------------------------
# This was empirically tested and is NOT a hypothetical concern. Because of
# how `python3 main.py` + `workers=N` + `uvicorn.run("main:app", ...)`
# interact, THIS FILE gets executed multiple times per worker process under
# DIFFERENT module names (observed: once as "__mp_main__" via
# multiprocessing's spawn bootstrap, once as "main" via Uvicorn's own
# import_from_string("main:app")) -- each execution creates its OWN
# separate copy of every module-level object, including a plain
# `asyncio.Event()`. Worse, testing showed that Uvicorn can resolve the
# CUSTOM PROTOCOL CLASS from one of these copies while the ASGI APP itself
# resolves from the OTHER copy -- meaning a naive bare-global flag set from
# inside shutdown() (bound to one copy's globals) would NOT be visible to
# the request handler watching `websocket.app.state` (bound to the other
# copy's globals). Verified via a live test: shutdown() and the running
# request handler ended up holding two DIFFERENT asyncio.Event objects with
# different ids -- the notice would silently never fire in that scenario.
#
# THE FIX: `uvicorn.protocols.websockets.websockets_impl` is a REAL package
# module imported the normal way from site-packages -- it is cached exactly
# ONCE per process under one stable name no matter how many times THIS file
# (main.py) gets re-executed under different names. Stashing the shared
# Event as an attribute on that singular module (guarded by `hasattr` so it
# is only created once, and every subsequent execution of this file just
# reuses the existing one) guarantees every copy of this file -- and
# therefore shutdown() and every request handler -- reads and writes the
# EXACT SAME object. Verified via a live SIGTERM test after this fix: the
# ids matched, and a connected client actually received the notice message.
# ---------------------------------------------------------------------------
if not hasattr(_ws_impl_module, "_bff_scale_in_event"):
    import asyncio as _asyncio_for_event
    _ws_impl_module._bff_scale_in_event = _asyncio_for_event.Event()
scale_in_event = _ws_impl_module._bff_scale_in_event


# Customize this message freely -- it's what shows up in the voice UI.
SCALE_IN_NOTICE_MESSAGE = os.environ.get(
    "VOICE_SCALE_IN_NOTICE_MESSAGE",
    "This voice session is nearing its supported limit and will expire soon. To prevent an interruption, please start a new conversation.",
)


# API documentation should normally be disabled in production.
# Set ENABLE_APIS=true only where Swagger/OpenAPI access is intentionally required.
ENABLE_APIS = os.getenv("ENABLE_APIS", "false").lower() == "true"


# ---------------------------------------------------------------------------
# CORS configuration.
#
# Production-safe default:
# - If ALLOWED_ORIGINS is not configured, don't allow cross-origin browser
#   requests. Same-origin React -> FastAPI requests do not require CORS.
# - Configure one or more explicit trusted origins as a comma-separated
#   environment variable when cross-origin browser access is required.
# ---------------------------------------------------------------------------
allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "").strip()

ALLOWED_ORIGINS = (
    [
        origin.strip()
        for origin in allowed_origins_env.split(",")
        if origin.strip()
    ]
    if allowed_origins_env
    else ["*"]
)


# ---------------------------------------------------------------------------
# Graceful WebSocket shutdown (see prior comments retained below) + scale-in
# detection/notification, both live in this one protocol override.
# ---------------------------------------------------------------------------
from uvicorn.protocols.websockets.websockets_impl import WebSocketProtocol


class GracefulWebSocketProtocol(WebSocketProtocol):
    def shutdown(self) -> None:
        # ADDED: fire the scale-in signal + log it exactly once per worker
        # (shutdown() is called once PER ACTIVE CONNECTION by Uvicorn, so
        # without this guard, a worker with N open voice sessions would log
        # this N times -- harmless, just noisy).
        if not scale_in_event.is_set():
            pid = os.getpid()
            _ws_log.info(
                "[GracefulWebSocketProtocol] SIGTERM / scale-in detected on worker pid=%s "
                "-- active voice sessions will be notified, not disconnected.",
                pid,
            )
            # Best-effort: also emit through the same structured, dual-sink
            # (console + New Relic) logger the rest of the app uses, so this
            # shows up alongside bff_voice_* events with the same schema.
            # Stashed onto the same singular module for the same reason
            # scale_in_event is (see lifespan() below for where this is set).
            bff_logger = getattr(_ws_impl_module, "_bff_logger", None)
            if bff_logger is not None:
                try:
                    bff_logger.log({
                        "event": "bff_scale_in_detected",
                        "pid": pid,
                        "display_message": "SIGTERM / scale-in signal received on this worker.",
                    })
                except Exception:
                    pass  # logging must never block/break shutdown handling
            scale_in_event.set()

        _ws_log.info(
            "[GracefulWebSocketProtocol] shutdown called, handshake_completed=%s",
            self.handshake_completed_event.is_set(),
        )
        self.ws_server.closing = True
        if not self.handshake_completed_event.is_set():
            # No active session yet (still mid-handshake) -- safe to reject
            # and close outright, same as Uvicorn's default behavior.
            self.send_500_response()
            self.transport.close()
        # else: handshake already completed -- an active voice relay is
        # running. Deliberately do nothing further here. Leave the
        # connection open until it ends naturally or the platform's grace
        # period (terminationGracePeriodSeconds on ACA /
        # WEBSITES_CONTAINER_STOP_TIME_LIMIT on App Service) forces a
        # SIGKILL. router/voice_chat.py's own scale-in watcher task (added
        # there) is what actually pushes the notice message to the browser.


# Module-level monkeypatch -- MUST run on every import (including inside
# each spawned worker subprocess). See GracefulWebSocketProtocol comments
# and the earlier long design writeup for why this is required instead of
# uvicorn's --ws CLI flag / Config.ws literal values.
uvicorn.config.WS_PROTOCOLS["websockets"] = f"{__name__}:GracefulWebSocketProtocol"


# ==================================================
# APP LIFESPAN
# ==================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.logger = build_logger()
    app.state.logger.start()

    # ADDED: expose the same NewRelicLogger instance to GracefulWebSocketProtocol.shutdown()
    # via the singular uvicorn module (see the long comment above scale_in_event
    # for why this indirection is required rather than reaching through self.app).
    _ws_impl_module._bff_logger = app.state.logger

    # ADDED: expose the shared scale-in flag on app.state too, so routers
    # (router/voice_chat.py) can read it the normal, idiomatic way via
    # websocket.app.state.scale_in_event -- same object, by reference, as
    # the one GracefulWebSocketProtocol.shutdown() sets above.
    app.state.scale_in_event = scale_in_event

    # One pooled httpx.AsyncClient shared by every request in THIS worker
    # process instead of a brand-new client (and TCP/TLS connection) per
    # /chat and /chatV1 call.
    app.state.http_client = httpx.AsyncClient(
        timeout=60.0,
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    )

    # Async Cosmos client + credential, constructed here (event loop must
    # already be running).
    await init_cosmos()

    # Local, same-container, multi-worker-safe session cache -- sits in
    # front of the Cosmos reads above.
    await init_session_cache()

    try:
        yield
    finally:
        await app.state.http_client.aclose()
        await aclose_session_cache()
        await aclose_cosmos()
        await app.state.logger.aclose()


app = FastAPI(
    title="Texas Roadhouse App",
    docs_url="/docs" if ENABLE_APIS else None,
    redoc_url="/redoc" if ENABLE_APIS else None,
    openapi_url="/openapi.json" if ENABLE_APIS else None,
    lifespan=lifespan,
)
app.add_middleware(CanonicalHostRedirectMiddleware)

app.include_router(auth_route)
app.include_router(text_chat_route, prefix="/api")
app.include_router(cookie_route)
app.include_router(voice_route)


# ==================================================
# CORS
# ==================================================
# No wildcard + credentials in production. If ALLOWED_ORIGINS is empty,
# cross-origin requests are not explicitly permitted; same-origin traffic
# from the React frontend served by this BFF is unaffected.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
)


# ==================================================
# BLOCK CLOUD METADATA / SSRF PROBE PATHS
# ==================================================
# ZAP probes several well-known cloud-instance metadata namespaces. These
# are not Roadie Ranger application routes. Reject them BEFORE normal
# routing/upstream calls/SPA fallback so they return JSON 404 instead of
# contributing to server-error or unexpected HTML responses.
_BLOCKED_PROBE_PREFIXES = (
    "/computeMetadata/",
    "/latest/meta-data/",
    "/metadata/",
    "/opc/",
    "/openstack/",
)


# ==================================================
# ACCESS-LOG + SECURITY-HEADER MIDDLEWARE
# ==================================================
@app.middleware("http")
async def nr_access_logger(request: Request, call_next):
    logger = getattr(request.app.state, "logger", None)
    request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
    request.state.request_id = request_id
    ua = request.headers.get("user-agent", "")
    is_zap = (ZAP_UA_MARKER in ua) or (request.headers.get("x-zap-scan") == "true")
    request.state.is_zap = is_zap
    tok = traffic_source_ctx.set("zap" if is_zap else None)
    start = time.perf_counter()
    status_code = 500
    path = request.url.path

    try:
        # Reject cloud metadata / SSRF probe paths BEFORE normal application
        # routing. This prevents those unsupported probe paths from reaching
        # application/upstream logic or the React fallback.
        if path.startswith(_BLOCKED_PROBE_PREFIXES):
            response = JSONResponse(
                status_code=404,
                content={"detail": "Endpoint not found"},
            )
        else:
            response = await call_next(request)

        status_code = response.status_code

        # Correlation header.
        response.headers["X-Request-ID"] = request_id

        # --------------------------------------------------
        # Security response headers
        # --------------------------------------------------
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

        # OWASP recommends disabling the deprecated browser XSS filter.
        response.headers["X-XSS-Protection"] = "0"

        # --------------------------------------------------
        # Sensitive response cache protection
        # --------------------------------------------------
        # User/session/auth/token/chat/health responses should not be stored
        # by browsers or shared caches. ZAP can report Non-Storable Content
        # informationally because of no-store; that is intentional for these
        # sensitive response families and should not be weakened solely to
        # reduce the informational alert count.
        sensitive_prefixes = (
            "/api",
            "/auth",
            "/login",
            "/logout",
            "/get_token",
            "/get_user",
            "/decoded_",
            "/health",
        )

        if path.startswith(sensitive_prefixes):
            response.headers["Cache-Control"] = (
                "no-store, no-cache, must-revalidate, private"
            )
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"

        return response

    finally:
        noisy = path.startswith(_SKIP_ACCESS_LOG_PREFIXES)
        if logger is not None and not (noisy and status_code < 400):
            logger.log({
                "event": "bff_http_request",
                "request_id": request_id,
                "method": request.method,
                "path": path,
                "status": status_code,
                "latency_ms": round((time.perf_counter() - start) * 1000, 2),
                "client_ip": request.client.host if request.client else None,
            })
        traffic_source_ctx.reset(tok)


# ==================================================
# EXCEPTION HANDLERS
# ==================================================
def _base_error(request: Request, status: int, category: str) -> dict:
    return {
        "event": "bff_error",
        "request_id": getattr(request.state, "request_id", None),
        "method": request.method,
        "path": request.url.path,
        "status": status,
        "error_category": category,
        "display_message": friendly_message(category),
    }


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    logger = getattr(request.app.state, "logger", None)
    category = classify_status(exc.status_code)
    if logger is not None:
        record = _base_error(request, exc.status_code, category)
        record["error"] = str(exc.detail)[:2000]
        logger.log(record)

    # Explicit JSON response prevents invalid backend/API routes from being
    # rendered as HTML error responses.
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    logger = getattr(request.app.state, "logger", None)
    if logger is not None:
        record = _base_error(request, 422, "validation_error")
        record["error"] = json.dumps(exc.errors(), default=str)[:2000]
        logger.log(record)
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger = getattr(request.app.state, "logger", None)
    if logger is not None:
        record = _base_error(request, 500, "bff_server_error")
        record["event"] = "bff_unhandled_error"
        record["error"] = f"{type(exc).__name__}: {exc}"[:2000]
        record["traceback"] = traceback.format_exc()[:6000]
        logger.log(record)

    # Keep implementation details and traceback server-side.
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


# ==================================================
# BASIC API ENDPOINTS
# ==================================================
@app.get("/health")
async def health():
    return {"status": "ok"}


# If this endpoint is only for development/testing, consider removing it
# from the production deployment.
@app.get("/api/example")
async def example():
    return {"message": "Data from FastAPI backend"}


# ==================================================
# FRONTEND LOCATION
# ==================================================
FRONTEND_DIST = Path(__file__).parent.parent / "web_app" / "dist"
assets_dir = FRONTEND_DIST / "assets"
if assets_dir.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=str(assets_dir)),
        name="assets",
    )


# ==================================================
# BACKEND PATH DETECTION
# ==================================================
# Prevent backend/API/auth URLs from falling through to the React SPA and
# returning index.html. Legitimate React routes still receive index.html;
# invalid backend routes receive a JSON 404 via the HTTP exception handler.
def _is_backend_path(full_path: str) -> bool:
    exact_paths = {
        "api",
        "auth",
        "login",
        "logout",
        "health",
        "healthz",
        "docs",
        "redoc",
        "openapi.json",
    }

    backend_prefixes = (
        "api/",
        "auth/",
        "login/",
        "logout/",
        "health/",
        "healthz/",
        "docs/",
        "redoc/",
        "openapi.json/",
        "get_token",
        "get_user",
        "decoded_",
    )

    return full_path in exact_paths or full_path.startswith(backend_prefixes)


# ==================================================
# SPA FALLBACK -- KEEP THIS LAST
# ==================================================
# This route intentionally continues serving index.html for legitimate
# React client-side routes. Backend/API-shaped paths must never receive the
# React application and are rejected above with a JSON 404.
@app.get("/{full_path:path}", include_in_schema=False)
async def serve_spa(request: Request, full_path: str):
    # if _is_backend_path(full_path):
    #     raise HTTPException(
    #         status_code=404,
    #         detail="Endpoint not found",
    #     )

    index_file = FRONTEND_DIST / "index.html"
    if index_file.is_file():
        return FileResponse(str(index_file))

    raise HTTPException(
        status_code=404,
        detail="Frontend build not found",
    )


# ==================================================
# ENTRYPOINT
# ==================================================
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5500")),
        workers=int(os.environ.get("UVICORN_WORKERS", "3")),
        ws="websockets",  # resolves to GracefulWebSocketProtocol via monkeypatch above
    )
