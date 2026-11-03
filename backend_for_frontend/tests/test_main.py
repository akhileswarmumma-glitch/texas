"""
================================================================================
SINGLE-FILE PYTEST SUITE for the BFF (Backend-For-Frontend) service
================================================================================

Covers EVERY file in this project:
    main.py
    router/auth.py, router/text_chat.py, router/cookies.py, router/voice_chat.py
    models/auth_models.py, models/chat_model.py
    utils/utils.py, utils/nr_logger.py, utils/canonical_redirect.py,
    utils/session_cache.py

Everything lives in this one file: fake `azure.*` module stubs, Cosmos
container fakes, MSAL app fakes, a fake upstream-websocket relay target,
shared fixtures, and every test. No conftest.py or other helper modules are
required -- just drop this file next to `main.py` (i.e. at the project root,
as a sibling of the `router/`, `models/`, `utils/` packages) and run:

    pip install -r requirements.txt   # or: pip install -e ".[test]"
    pytest -q test_main.py

WHY `azure.*` AND `msal` ARE FAKED, BUT `diskcache` IS USED FOR REAL:
    `azure-identity` / `azure-keyvault-secrets` / `azure-cosmos` all make
    REAL NETWORK CALLS at some point (Key Vault secret fetches, Cosmos
    reads/writes) -- those must be faked for hermetic, offline unit tests.
    `msal.ConfidentialClientApplication(...)` ALSO makes a real network call
    at CONSTRUCTION time (OIDC tenant discovery against
    `https://login.microsoftonline.com/<tenant>/v2.0/.well-known/
    openid-configuration`) -- so the whole `msal` package is faked too (see
    the fake `msal.ConfidentialClientApplication` in section 1); individual
    tests instead assign a small, fully-controllable `FakeMsalApp` (section
    4) directly to `router.auth._msal_app_singleton`. `diskcache.Cache`, by
    contrast, does only LOCAL SQLite file I/O (no network, ever) -- we let
    it run for real against a throwaway temp directory, which gives genuine
    test coverage of `utils/session_cache.py` (TTL expiry, get/set/delete)
    rather than testing a mock of it.

IMPORTANT -- ENV VARS ARE FORCE-SET, NOT `setdefault()`-ED:
    Same reasoning as the other services in this project: a CI pipeline may
    pre-export these variable NAMES as empty strings before the unit-test
    stage populates them, silently defeating a `setdefault()`-based default.
    Every env var this file depends on is force-assigned
    (`os.environ[name] = value`) BEFORE `import main` runs. `SESSION_CACHE_DIR`
    in particular MUST be set before import, since `utils/session_cache.py`
    reads it at module import time into the `CACHE_DIR` constant.

Section index (search for these headers):
  1. FAKE AZURE MODULES + ENV VARS (must run before `import main`)
  2. IMPORT MODULE UNDER TEST (main.py, plus the router/utils/models
     submodules it pulls in transitively)
  3. COSMOS CONTAINER TEST HELPERS (AsyncMock-based, swapped onto
     router.auth's module-level container_* globals per test)
  4. MSAL TEST HELPERS (FakeMsalApp, swapped onto
     router.auth._msal_app_singleton per test)
  5. FAKE UPSTREAM WEBSOCKET (for router/voice_chat.py relay tests --
     stands in for the real `websockets.connect(...)` upstream connection
     to the voice backend)
  6. SHARED FIXTURES (TestClient with real lifespan, auth override,
     cosmos/msal reset)
  7. TESTS: models (auth_models.py, chat_model.py) -- trivial but included
     for completeness
  8. TESTS: utils/utils.py (decode_jwt_token, create_session, dependency
     functions, user_from_session, classify_status/friendly_message)
  9. TESTS: utils/nr_logger.py (NewRelicLogger -- console echo, batching,
     shipping, disabled/console-only mode, build_logger)
  10. TESTS: utils/session_cache.py (REAL diskcache -- init/aclose,
      get/set/invalidate, TTL expiry)
  11. TESTS: utils/canonical_redirect.py (CanonicalHostRedirectMiddleware)
  12. TESTS: router/cookies.py
  13. TESTS: router/auth.py -- pure helpers (resolve_redirect_uri, login-flow
      store/pop, msal_app singleton, get_user_oid, get_session_from_cosmos)
  14. TESTS: router/auth.py -- HTTP routes (/login, /auth/callback,
      /get_token_with_session_id, /decoded_*_token_details, /auth/me,
      /get_user_details, /logout) via TestClient
  15. TESTS: router/text_chat.py (/api/get_conversation_id, /api/chat,
      /api/chatV1 streaming) via TestClient
  16. TESTS: router/voice_chat.py (/voice/chat websocket relay) via
      TestClient.websocket_connect
  17. TESTS: main.py -- app-level (health, access-log middleware, exception
      handlers, SPA fallback, lifespan wiring, GracefulWebSocketProtocol)
================================================================================
"""
from __future__ import annotations  # noqa: E402 -- see other test files in
# this project for why: makes every annotation in this file lazy (string,
# never evaluated at runtime), so subscripted-builtin generics used as
# annotations (e.g. `-> tuple[str, str]`) don't require a specific Python
# minor version to parse.

# =============================================================================
# Standard library / third-party imports used across the whole file
# =============================================================================
import asyncio
import contextlib
import json
import os
import shutil
import sys
import tempfile
import time
import types
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import jwt as pyjwt
import pytest

# =============================================================================
# 1. FAKE AZURE MODULES + ENV VARS  (must run before `import main`)
# =============================================================================
_TEST_CACHE_DIR = tempfile.mkdtemp(prefix="bff_test_session_cache_")

_TEST_ENV_VALUES = {
    "ALLOWED_ORIGINS": "https://app.example.com",
    "ENABLE_APIS": "false",
    "KEY_VAULT": "test-keyvault",
    # These three are Key-Vault SECRET NAMES (not the secret values
    # themselves) -- router/auth.py looks up a secret whose NAME is the
    # value of each of these env vars. Our FakeSecretClient resolves any
    # non-empty name to f"{name}-secret-value", deterministically.
    "AAD_CLIENT_ID": "aad-client-id-secret-name",
    "AAD_CLIENT_SECRET": "aad-client-secret-secret-name",
    "AAD_TENANT_ID": "aad-tenant-id-secret-name",
    "AAD_REDIRECT_URI": "https://app.example.com/auth/callback",
    "AAD_REDIRECT_URIS": "https://app.example.com/auth/callback,https://other.example.com/auth/callback",
    "POST_LOGIN_REDIRECT": "https://app.example.com/",
    "AAD_LOGIN_SCOPES": "https://app.example.com",
    "LOGIN_FLOW_TTL_SECONDS": "600",
    "COSMOS_ENDPOINT": "https://test-cosmos.documents.azure.com:443/",
    "COSMOS_TOKEN_DATABASE_NAME": "test-token-db",
    "BACKEND_URL_TEXT": "http://text-backend.internal:8001",
    "BACKEND_URL_VOICE": "ws://voice-backend.internal:3001",
    "SESSION_CACHE_DIR": _TEST_CACHE_DIR,
    "SESSION_CACHE_TTL_SECONDS": "45",
    "CANONICAL_HOST": "canonical.example.com",
    "CANONICAL_SCHEME": "https",
    "KNOWN_REDIRECT_HOSTS": "alt.example.com,app.azurewebsites.net",
    "CANONICAL_REDIRECT_EXEMPT_PATHS": "/health,/healthz",
    "UNKNOWN_HOST_BEHAVIOR": "pass",
    "INIT_HANDSHAKE_TIMEOUT_S": "10",
    "MAX_RELAY_FRAME_BYTES": str(20 * 1024 * 1024),
}
for _k, _v in _TEST_ENV_VALUES.items():
    os.environ[_k] = _v
# Deliberately force-EMPTY -- New Relic shipping stays disabled (console-only
# mode) for the test run; no background HTTP shipping thread/task started
# against a fake/unreachable URL.
os.environ["NEW_RELIC_LICENSE_KEY"] = ""
os.environ["NEW_RELIC_LOG_URL"] = ""
os.environ["NEW_RELIC_LOGTYPE"] = "bff_test"
os.environ["NEW_RELIC_SERVICE_NAME"] = "bff-test"
os.environ["NEW_RELIC_CONSOLE_ECHO"] = "true"


def _make_module(name: str) -> types.ModuleType:
    mod = types.ModuleType(name)
    sys.modules[name] = mod
    return mod


# ---- top-level `azure` namespace package -----------------------------------
_make_module("azure")

# ---- azure.identity (SYNC) / azure.identity.aio (ASYNC) --------------------
_azure_identity = _make_module("azure.identity")
_azure_identity_aio = _make_module("azure.identity.aio")


class FakeDefaultAzureCredential:
    """Sync credential -- used by nr_logger.py (Key Vault) and
    router/auth.py's sync SecretClient. `.close()` is sync."""

    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeAsyncDefaultAzureCredential:
    """Async credential -- used by router/auth.py's async Cosmos client.
    `.close()` is a coroutine."""

    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs
        self.closed = False

    async def close(self) -> None:
        self.closed = True


_azure_identity.DefaultAzureCredential = FakeDefaultAzureCredential
_azure_identity_aio.DefaultAzureCredential = FakeAsyncDefaultAzureCredential

# ---- azure.keyvault.secrets -------------------------------------------------
_azure_keyvault = _make_module("azure.keyvault")
_azure_keyvault_secrets = _make_module("azure.keyvault.secrets")


class FakeSecretClient:
    """Fake Key Vault client: resolves a secret name to a deterministic,
    test-only value of f'{name}-secret-value' -- never touches the network.
    Falsy/None names resolve to an empty string (matching "not configured")."""

    def __init__(self, vault_url, credential):
        self.vault_url = vault_url
        self.credential = credential

    def get_secret(self, name):
        if not name:
            return SimpleNamespace(value="")
        return SimpleNamespace(value=f"{name}-secret-value")


_azure_keyvault_secrets.SecretClient = FakeSecretClient

# ---- azure.cosmos.aio (ASYNC CosmosClient) ---------------------------------
_azure_cosmos = _make_module("azure.cosmos")
_azure_cosmos_aio = _make_module("azure.cosmos.aio")


class _DefaultFakeContainer:
    """Placeholder container installed at import time so `init_cosmos()`
    (run once, for real, by the TestClient lifespan fixture -- see section
    6) has something non-None to assign to `container_sessions` /
    `container_user` / `container_login_flows`. Every route-level test then
    OVERWRITES these three module attributes with fresh, per-test
    `AsyncMock()` instances (see `_reset_cosmos_containers` fixture) --
    this class's own methods are never actually exercised by any test."""

    async def create_item(self, *a, **kw):
        return {}

    async def read_item(self, *a, **kw):
        return {}

    async def patch_item(self, *a, **kw):
        return {}

    async def delete_item(self, *a, **kw):
        return {}


class _FakeDatabase:
    def get_container_client(self, name):
        return _DefaultFakeContainer()


class FakeCosmosClient:
    def __init__(self, endpoint, credential):
        self.endpoint = endpoint
        self.credential = credential
        self.closed = False

    def get_database_client(self, name):
        return _FakeDatabase()

    async def close(self) -> None:
        self.closed = True


_azure_cosmos_aio.CosmosClient = FakeCosmosClient

# ---- msal -------------------------------------------------------------------
# CORRECTION vs. this file's original plan: `msal.ConfidentialClientApplication.
# __init__` is NOT purely local -- it performs REAL OIDC tenant discovery over
# the network (a GET to .../v2.0/.well-known/openid-configuration) unless that
# authority is pre-registered/well-known. That makes constructing a real one
# unsuitable for hermetic unit tests, so -- unlike diskcache -- `msal` IS
# faked here (matching the ServiceNow MCP server's test suite in this same
# project). `router.auth.msal_app()` builds its singleton from this fake
# class; individual tests instead usually bypass that entirely by assigning
# a `FakeMsalApp` (section 4 below) directly to
# `router_auth._msal_app_singleton`.
_msal = _make_module("msal")


class FakeConfidentialClientApplication:
    def __init__(self, client_id=None, client_credential=None, authority=None):
        self.client_id = client_id
        self.client_credential = client_credential
        self.authority = authority

    def initiate_auth_code_flow(self, scopes, redirect_uri):
        raise NotImplementedError("configure via FakeMsalApp / router_auth._msal_app_singleton instead")

    def acquire_token_by_auth_code_flow(self, flow, query_params):
        raise NotImplementedError("configure via FakeMsalApp / router_auth._msal_app_singleton instead")

    def acquire_token_on_behalf_of(self, user_assertion, scopes):
        raise NotImplementedError("configure via FakeMsalApp / router_auth._msal_app_singleton instead")


_msal.ConfidentialClientApplication = FakeConfidentialClientApplication


# =============================================================================
# 2. IMPORT MODULE UNDER TEST
# =============================================================================
import main  # noqa: E402
import router.auth as router_auth  # noqa: E402
import router.text_chat as router_text_chat  # noqa: E402
import router.voice_chat as router_voice_chat  # noqa: E402
import utils.utils as utils_utils  # noqa: E402
import utils.nr_logger as nr_logger_module  # noqa: E402
import utils.session_cache as session_cache_module  # noqa: E402
import utils.canonical_redirect as canonical_redirect_module  # noqa: E402
from models.auth_models import (  # noqa: E402
    SSOToken, SuccessResponse, ConversationResponse, UserData,
    UserDetailResponse, DeleteResponse,
)
from models.chat_model import ChatRequest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


# =============================================================================
# 3. COSMOS CONTAINER TEST HELPERS
# =============================================================================
def fresh_async_mock_container() -> AsyncMock:
    """A plain AsyncMock covers create_item/read_item/patch_item/delete_item
    (and anything else) with zero boilerplate -- each test configures
    `.return_value` / `.side_effect` directly, then asserts on call args."""
    return AsyncMock()


def make_session_doc(
    *, session_id: str = "sess-1", user_oid: str = "oid-1", username: str = "alice@example.com",
    user_token: Optional[str] = None, foundry_token: str = "foundry-tok", speech_token: str = "speech-tok",
    expires_in_minutes: int = 60,
) -> dict:
    if user_token is None:
        user_token = make_jwt({"oid": user_oid, "name": "Alice Example", "preferred_username": username})
    now = datetime.now(timezone.utc)
    return {
        "id": session_id,
        "user_oid": user_oid,
        "username": username,
        "user_token": user_token,
        "foundry_token": foundry_token,
        "speech_token": speech_token,
        "created_at": now.isoformat(),
        "last_seen": now.isoformat(),
        "expires_at": (now + timedelta(minutes=expires_in_minutes)).isoformat(),
        "ttl": 5400,
    }


# =============================================================================
# 4. MSAL TEST HELPERS
# =============================================================================
class FakeMsalApp:
    """Configurable fake for `router.auth.msal_app()`'s return value.
    Every method returns a canned success result by default; tests
    override `.xxx_result` / `.xxx_exception` per scenario."""

    def __init__(self):
        self.initiate_result = {"auth_uri": "https://login.microsoftonline.com/fake-auth-uri"}
        self.acquire_by_flow_result = {"access_token": "user-token-abc"}
        self.acquire_by_flow_exception: Optional[BaseException] = None
        self.obo_results_by_scope: dict[tuple, dict] = {}
        self.obo_default_result = {"access_token": "obo-token-default"}
        self.calls: list[dict] = []

    def initiate_auth_code_flow(self, scopes, redirect_uri):
        self.calls.append({"method": "initiate_auth_code_flow", "scopes": scopes, "redirect_uri": redirect_uri})
        return self.initiate_result

    def acquire_token_by_auth_code_flow(self, flow, query_params):
        self.calls.append({"method": "acquire_token_by_auth_code_flow", "flow": flow, "query_params": query_params})
        if self.acquire_by_flow_exception:
            raise self.acquire_by_flow_exception
        return self.acquire_by_flow_result

    def acquire_token_on_behalf_of(self, user_assertion, scopes):
        self.calls.append({"method": "acquire_token_on_behalf_of", "user_assertion": user_assertion, "scopes": tuple(scopes)})
        key = tuple(scopes)
        return self.obo_results_by_scope.get(key, self.obo_default_result)


def install_fake_msal_app() -> FakeMsalApp:
    fake_app = FakeMsalApp()
    router_auth._msal_app_singleton = fake_app
    return fake_app


def make_jwt(claims: dict, secret: str = "unused-signing-secret-at-least-32-bytes-long") -> str:
    """decode_jwt_token() explicitly does NOT verify signature (by design --
    see its docstring), so an HS256 token with a throwaway secret is a fine,
    simple stand-in everywhere in this test file."""
    return pyjwt.encode(claims, secret, algorithm="HS256")


# =============================================================================
# 5. FAKE UPSTREAM WEBSOCKET  (stands in for `websockets.connect(...)` to the
#    voice backend, for router/voice_chat.py relay tests)
# =============================================================================
class FakeUpstreamWebSocket:
    """Minimal async stand-in for a `websockets` client connection: supports
    `async for message in ws` (iterating received frames) and `await
    ws.send(data)` (recording sent frames). Also used as the object
    `websockets.connect(...)` "returns" via `__aenter__`/`__aexit__`."""

    def __init__(self, incoming: Optional[list] = None, connect_exception: Optional[BaseException] = None):
        self._incoming: asyncio.Queue = asyncio.Queue()
        for item in (incoming or []):
            self._incoming.put_nowait(item)
        self._closed = False
        self.sent: list = []
        self.connect_exception = connect_exception

    async def queue_message(self, message) -> None:
        await self._incoming.put(message)

    async def close_incoming(self) -> None:
        await self._incoming.put(StopAsyncIteration)

    async def send(self, data) -> None:
        if self._closed:
            raise RuntimeError("connection closed")
        self.sent.append(data)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self._incoming.get()
        if item is StopAsyncIteration:
            raise StopAsyncIteration
        return item

    # ---- async context manager protocol (what `_open_upstream_connection`
    #      is awaited/entered/exited through in router/voice_chat.py) -------
    async def __aenter__(self):
        if self.connect_exception:
            raise self.connect_exception
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self._closed = True
        return False


def install_fake_upstream(monkeypatch, upstream: FakeUpstreamWebSocket) -> None:
    """Patches `router.voice_chat.websockets.connect` so
    `_open_upstream_connection(...)` (which calls `websockets.connect(...)`
    and later awaits `__aenter__`/`__aexit__` on the result) receives our
    fake instead of opening a real TCP connection."""

    def _fake_connect(url, **kwargs):
        return upstream

    monkeypatch.setattr(router_voice_chat.websockets, "connect", _fake_connect)


# =============================================================================
# 6. SHARED FIXTURES
# =============================================================================
def run_async(coro):
    """Helper to run a coroutine in tests without needing pytest-asyncio."""
    return asyncio.run(coro)


def flush_console_echo(app) -> None:
    """Deterministically waits for every console-echo print job already
    submitted to `NewRelicLogger._console_executor` to finish.

    WHY THIS EXISTS: `NewRelicLogger.log()` dispatches its actual
    `print(..., flush=True)` onto a dedicated single-worker background
    thread via `loop.run_in_executor(...)` and does NOT await it (that's
    the whole point -- see nr_logger.py's module docstring on avoiding
    blocking the event loop). That means a plain `client.get(...)` /
    `client.post(...)` call can return, and `capsys.readouterr()` can run,
    BEFORE that background thread has actually written its line to stdout
    -- a real, observed race (not hypothetical) that intermittently failed
    a couple of console-output-asserting tests in this suite. Since the
    executor has exactly ONE worker thread and processes submitted jobs in
    FIFO order, submitting one more (trivial) job and waiting for IT to
    finish guarantees every job submitted before it has already completed
    -- a fast, deterministic wait instead of an arbitrary `time.sleep(...)`.
    """
    logger = getattr(app.state, "logger", None)
    if logger is None:
        return
    executor = getattr(logger, "_console_executor", None)
    if executor is None:
        return
    executor.submit(lambda: None).result(timeout=5)


@pytest.fixture(scope="session", autouse=True)
def _cleanup_test_cache_dir():
    yield
    shutil.rmtree(_TEST_CACHE_DIR, ignore_errors=True)


@pytest.fixture()
def client():
    """A TestClient with the REAL lifespan actually run (build_logger(),
    init_cosmos(), init_session_cache() all execute for real against our
    fakes / real-but-local diskcache) -- then, immediately after startup,
    every Cosmos container is swapped for a fresh AsyncMock so each test
    gets full, isolated control over "Cosmos" behavior without needing to
    re-run the whole lifespan per test."""
    # base_url matches an entry in AAD_REDIRECT_URIS (https://app.example.com)
    # so /login and /auth/callback tests resolve a valid, allow-listed
    # redirect_uri by default without every single test needing to pass
    # explicit Host/X-Forwarded-Host headers.
    with TestClient(main.app, base_url="https://app.example.com") as c:
        router_auth.container_sessions = fresh_async_mock_container()
        router_auth.container_user = fresh_async_mock_container()
        router_auth.container_login_flows = fresh_async_mock_container()
        yield c


@pytest.fixture(autouse=True)
def _reset_msal_singleton():
    """Ensure no MSAL app instance leaks between tests."""
    router_auth._msal_app_singleton = None
    yield
    router_auth._msal_app_singleton = None


@pytest.fixture()
def enable_dev_apis(monkeypatch):
    """router/auth.py's dev_only() dependency (used by /get_token_with_session_id and
    /decoded_*_token_details) reads the module-level ENABLE_APIS flag on every call
    and returns 404 when it is False. The suite sets ENABLE_APIS="false" (the
    production-safe setting), so tests for those dev-only routes opt in explicitly
    by flipping the flag for the duration of the test."""
    monkeypatch.setattr(router_auth, "ENABLE_APIS", True)


@pytest.fixture()
def fake_session():
    """A ready-to-use session object matching the shape `get_current_session`
    (really `SSOToken`) or a plain namespace with `.sso_token` would provide
    to a dependent route -- used to override `get_current_session` directly
    via FastAPI's `dependency_overrides` for router-level tests that don't
    want to exercise the full Cosmos-backed session lookup themselves."""
    return SimpleNamespace(sso_token=make_session_doc())


@pytest.fixture()
def override_session(fake_session):
    """Overrides `router_auth.get_current_session` (the shared dependency
    used by text_chat.py, voice_chat.py, and auth.py's own token-detail
    routes) to return `fake_session` directly, bypassing Cosmos/cache
    entirely -- appropriate for tests that are about the ROUTE's own logic,
    not session-resolution itself (which has its own dedicated tests in
    section 13/14)."""
    main.app.dependency_overrides[router_auth.get_current_session] = lambda: fake_session
    yield fake_session
    main.app.dependency_overrides.pop(router_auth.get_current_session, None)


# =============================================================================
# 7. TESTS: models (auth_models.py, chat_model.py)
# =============================================================================
def test_chat_request_model_shape():
    req = ChatRequest(user_message="hi", previous_response_id="", conversation_id="conv-1")
    assert req.user_message == "hi"
    assert req.conversation_id == "conv-1"


def test_sso_token_model():
    tok = SSOToken(message="Success", sso_token={"a": 1})
    assert tok.message == "Success"
    assert tok.sso_token == {"a": 1}


def test_success_and_delete_response_models():
    assert SuccessResponse(message="Success").message == "Success"
    assert DeleteResponse(message="Success").message == "Success"


def test_conversation_response_model():
    resp = ConversationResponse(message="Success", conversation_id="conv-1")
    assert resp.conversation_id == "conv-1"


def test_user_detail_response_model():
    data = UserData(name="Alice", preferred_username="alice@example.com")
    resp = UserDetailResponse(message="Success", data=data)
    assert resp.data.name == "Alice"
    assert resp.data.preferred_username == "alice@example.com"


# =============================================================================
# 8. TESTS: utils/utils.py
# =============================================================================
def test_decode_jwt_token_valid():
    token = make_jwt({"oid": "abc", "name": "Bob"})
    claims = utils_utils.decode_jwt_token(token)
    assert claims["oid"] == "abc"
    assert claims["name"] == "Bob"


def test_decode_jwt_token_does_not_verify_signature():
    # Signed with an arbitrary secret main.py never configured -- decoding
    # must still succeed since verify_signature=False is explicit.
    token = pyjwt.encode({"oid": "xyz"}, "totally-different-secret-value-32-bytes-plus", algorithm="HS256")
    claims = utils_utils.decode_jwt_token(token)
    assert claims["oid"] == "xyz"


def test_decode_jwt_token_malformed_raises_http_500():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        utils_utils.decode_jwt_token("not-a-valid-jwt-at-all")
    assert exc_info.value.status_code == 500


def test_create_session_generates_url_safe_unique_ids():
    ids = {utils_utils.create_session() for _ in range(20)}
    assert len(ids) == 20
    for sid in ids:
        assert isinstance(sid, str) and len(sid) > 20


def test_get_logger_dependency_reads_app_state():
    fake_request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(logger="the-logger")))
    assert utils_utils.get_logger(fake_request) == "the-logger"


def test_get_ws_logger_dependency_reads_app_state():
    fake_ws = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(logger="the-ws-logger")))
    assert utils_utils.get_ws_logger(fake_ws) == "the-ws-logger"


def test_get_http_client_dependency_reads_app_state():
    fake_request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(http_client="the-client")))
    assert utils_utils.get_http_client(fake_request) == "the-client"


def test_user_from_session_extracts_oid_and_name():
    session = SimpleNamespace(sso_token={"user_token": make_jwt({"oid": "oid-1", "name": "Carol"})})
    info = utils_utils.user_from_session(session)
    assert info == {"user_oid": "oid-1", "user_name": "Carol"}


def test_user_from_session_falls_back_to_preferred_username():
    session = SimpleNamespace(sso_token={"user_token": make_jwt({"oid": "oid-2", "preferred_username": "dave@example.com"})})
    info = utils_utils.user_from_session(session)
    assert info["user_name"] == "dave@example.com"


def test_user_from_session_none_session_returns_none_fields():
    info = utils_utils.user_from_session(None)
    assert info == {"user_oid": None, "user_name": None}


def test_user_from_session_missing_sso_token_returns_none_fields():
    session = SimpleNamespace(sso_token=None)
    info = utils_utils.user_from_session(session)
    assert info == {"user_oid": None, "user_name": None}


def test_user_from_session_never_raises_on_garbage_input():
    class Weird:
        @property
        def sso_token(self):
            raise RuntimeError("boom")
    info = utils_utils.user_from_session(Weird())
    assert info == {"user_oid": None, "user_name": None}


@pytest.mark.parametrize(
    "status, expected_category",
    [
        (401, "auth_error"), (403, "auth_error"), (404, "not_found"),
        (422, "validation_error"), (429, "rate_limited"),
        (502, "upstream_error"), (503, "upstream_error"), (504, "upstream_error"),
        (400, "client_error"), (418, "client_error"),
        (500, "bff_server_error"), (599, "bff_server_error"),
    ],
)
def test_classify_status(status, expected_category):
    assert utils_utils.classify_status(status) == expected_category


def test_friendly_message_known_categories():
    assert utils_utils.friendly_message("auth_error") == "Authentication or authorization failed."
    assert utils_utils.friendly_message("bff_proxy_error") == "The BFF could not reach the backend service."


def test_friendly_message_unknown_category_falls_back():
    assert utils_utils.friendly_message("some_unknown_category") == "An error occurred."


# =============================================================================
# 9. TESTS: utils/nr_logger.py
# =============================================================================
def _make_nr_logger(**overrides) -> "nr_logger_module.NewRelicLogger":
    defaults = dict(
        license_key="", url="", logtype="test_logtype", service_name="test-service",
        flush_interval=0.05, max_batch=100, max_queue=100, console_echo=True,
    )
    defaults.update(overrides)
    return nr_logger_module.NewRelicLogger(**defaults)


def test_new_relic_logger_disabled_when_no_license_key_or_url(caplog):
    with caplog.at_level("WARNING", logger="nr_logger"):
        logger = _make_nr_logger(license_key="", url="")
    assert logger._nr_enabled is False
    assert any("CONSOLE-ONLY mode" in r.message for r in caplog.records)


def test_new_relic_logger_enabled_when_both_key_and_url_set():
    logger = _make_nr_logger(license_key="k", url="https://x.example/log/v1")
    assert logger._nr_enabled is True


def test_new_relic_logger_start_noop_when_disabled():
    logger = _make_nr_logger(license_key="", url="")
    logger.start()
    assert logger._task is None
    assert logger._client is None


def test_new_relic_logger_log_console_echo_writes_json_line(capsys):
    async def scenario():
        logger = _make_nr_logger(console_echo=True)
        logger.log({"event": "my_event", "foo": "bar"})
        await asyncio.sleep(0.05)  # let the executor-dispatched print land
        await logger.aclose()

    run_async(scenario())
    captured = capsys.readouterr()
    payload = json.loads(captured.out.strip().splitlines()[-1])
    assert payload["event"] == "my_event"
    assert payload["foo"] == "bar"


def test_new_relic_logger_log_enriches_record_with_metadata(capsys):
    async def scenario():
        logger = _make_nr_logger(service_name="svc-x", logtype="lt-x")
        logger.log({"event": "e1"})
        await asyncio.sleep(0.05)
        await logger.aclose()

    run_async(scenario())
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["service.name"] == "svc-x"
    assert payload["logtype"] == "lt-x"
    assert "timestamp" in payload
    assert "timestamp_iso" in payload
    assert "host" in payload
    assert payload["message"] == "e1"  # falls back to event when no "message" key


def test_new_relic_logger_log_message_key_takes_precedence_over_event(capsys):
    async def scenario():
        logger = _make_nr_logger()
        logger.log({"event": "e1", "message": "custom message"})
        await asyncio.sleep(0.05)
        await logger.aclose()

    run_async(scenario())
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["message"] == "custom message"


def test_new_relic_logger_log_uses_traffic_source_ctx(capsys):
    async def scenario():
        logger = _make_nr_logger()
        token = nr_logger_module.traffic_source_ctx.set("zap")
        try:
            logger.log({"event": "e1"})
        finally:
            nr_logger_module.traffic_source_ctx.reset(token)
        await asyncio.sleep(0.05)
        await logger.aclose()

    run_async(scenario())
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["traffic_source"] == "zap"


def test_new_relic_logger_log_does_not_overwrite_explicit_traffic_source(capsys):
    async def scenario():
        logger = _make_nr_logger()
        token = nr_logger_module.traffic_source_ctx.set("zap")
        try:
            logger.log({"event": "e1", "traffic_source": "explicit"})
        finally:
            nr_logger_module.traffic_source_ctx.reset(token)
        await asyncio.sleep(0.05)
        await logger.aclose()

    run_async(scenario())
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["traffic_source"] == "explicit"


def test_new_relic_logger_serialize_failure_falls_back_to_error_line(capsys):
    class Unserializable:
        def __str__(self):
            raise RuntimeError("no string")

    async def scenario():
        logger = _make_nr_logger()
        logger.log({"event": "e1", "bad": Unserializable()})
        await asyncio.sleep(0.05)
        await logger.aclose()

    run_async(scenario())
    payload = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert payload["event"] == "bff_log_serialize_error"


def test_new_relic_logger_queue_full_drops_silently_and_warns(caplog):
    logger = _make_nr_logger(license_key="k", url="https://x.example/log/v1", max_queue=1, console_echo=False)
    # Do NOT call start() -- the queue is never drained, so it fills up.
    with caplog.at_level("WARNING", logger="nr_logger"):
        logger.log({"event": "e1"})
        logger.log({"event": "e2"})  # queue is full -> dropped, must not raise
    assert any("queue full" in r.message for r in caplog.records)


def test_new_relic_logger_ships_batches_via_real_run_loop():
    shipped_payloads = []

    class FakeHttpxClient:
        def __init__(self, *a, **kw):
            pass

        async def post(self, url, headers, content):
            shipped_payloads.append({"url": url, "headers": headers, "body": json.loads(content)})
            return httpx.Response(202)

        async def aclose(self):
            pass

    async def scenario():
        with patch.object(nr_logger_module.httpx, "AsyncClient", FakeHttpxClient):
            logger = _make_nr_logger(
                license_key="my-key", url="https://log-api.example/log/v1",
                logtype="mytype", service_name="myservice", console_echo=False,
                flush_interval=0.05, max_batch=100,
            )
            logger.start()
            logger.log({"event": "e1"})
            logger.log({"event": "e2"})
            await asyncio.sleep(0.2)  # let the flush_interval elapse at least once
            await logger.aclose()

    run_async(scenario())
    assert len(shipped_payloads) >= 1
    all_messages = [m["message"] for p in shipped_payloads for m in p["body"][0]["logs"]]
    assert "e1" in all_messages
    assert "e2" in all_messages
    assert shipped_payloads[0]["headers"]["Api-Key"] == "my-key"
    assert shipped_payloads[0]["body"][0]["common"]["attributes"]["logtype"] == "mytype"


def test_new_relic_logger_ship_handles_non_2xx_response(caplog):
    async def scenario():
        logger = _make_nr_logger(license_key="k", url="https://x.example/log/v1", console_echo=False)
        logger._client = AsyncMock()
        logger._client.post.return_value = httpx.Response(500, text="server error")
        with caplog.at_level("WARNING", logger="nr_logger"):
            await logger._ship([{"event": "e1"}])
        return caplog.records

    records = run_async(scenario())
    assert any("ingest failed" in r.message for r in records)


def test_new_relic_logger_ship_handles_client_exception(caplog):
    async def scenario():
        logger = _make_nr_logger(license_key="k", url="https://x.example/log/v1", console_echo=False)
        logger._client = AsyncMock()
        logger._client.post.side_effect = RuntimeError("network down")
        with caplog.at_level("WARNING", logger="nr_logger"):
            await logger._ship([{"event": "e1"}])  # must not raise
        return caplog.records

    records = run_async(scenario())
    assert any("ingest exception" in r.message for r in records)


def test_new_relic_logger_ship_noop_for_empty_batch_or_no_client():
    async def scenario():
        logger = _make_nr_logger(console_echo=False)
        await logger._ship([])  # no client, empty batch -- must not raise
        logger._client = AsyncMock()
        await logger._ship([])  # empty batch even with a client -- still a no-op
        logger._client.post.assert_not_called()

    run_async(scenario())


def test_build_logger_reads_config_from_env_and_secret_client():
    logger = nr_logger_module.build_logger()
    assert logger.logtype == "bff_test"
    assert logger.service_name == "bff-test"
    # NEW_RELIC_LICENSE_KEY env var is "" -> FakeSecretClient.get_secret("")
    # resolves to "" (falsy secret name -> empty value) -> disabled.
    assert logger._nr_enabled is False


# =============================================================================
# 10. TESTS: utils/session_cache.py  (REAL diskcache against a throwaway
#     temp directory -- see module docstring section 1 for why)
# =============================================================================
@pytest.fixture()
def isolated_session_cache(monkeypatch):
    """Runs init_session_cache()/aclose_session_cache() against a FRESH,
    per-test temp directory (not the shared `_TEST_CACHE_DIR` the app's own
    lifespan uses), so cache-content tests never interfere with each other
    or with the `client` fixture's own cache instance."""
    temp_dir = tempfile.mkdtemp(prefix="bff_test_session_cache_case_")
    monkeypatch.setattr(session_cache_module, "CACHE_DIR", temp_dir)
    run_async(session_cache_module.init_session_cache())
    try:
        yield
    finally:
        run_async(session_cache_module.aclose_session_cache())
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_session_cache_get_miss_returns_none(isolated_session_cache):
    result = run_async(session_cache_module.get_cached_session("nonexistent"))
    assert result is None


def test_session_cache_set_then_get_round_trips(isolated_session_cache):
    doc = {"id": "sess-1", "user_oid": "oid-1"}
    run_async(session_cache_module.set_cached_session("sess-1", doc))
    result = run_async(session_cache_module.get_cached_session("sess-1"))
    assert result == doc


def test_session_cache_invalidate_removes_entry(isolated_session_cache):
    doc = {"id": "sess-1"}
    run_async(session_cache_module.set_cached_session("sess-1", doc))
    run_async(session_cache_module.invalidate_cached_session("sess-1"))
    assert run_async(session_cache_module.get_cached_session("sess-1")) is None


def test_session_cache_ttl_expiry(isolated_session_cache, monkeypatch):
    # NOTE: uses a generous margin (0.2s TTL / up to ~3s poll) rather than a
    # single fixed sleep -- diskcache's expiry is wall-clock/real-time based
    # (backed by actual SQLite reads), and a single tight sleep() proved
    # genuinely flaky under load in a shared CI/sandbox environment (the
    # background thread pool + disk I/O can occasionally take longer than
    # a small fixed margin). Polling up to a generous timeout keeps the
    # test fast in the common case while eliminating that flakiness.
    monkeypatch.setattr(session_cache_module, "CACHE_TTL_SECONDS", 0.2)
    doc = {"id": "sess-1"}
    run_async(session_cache_module.set_cached_session("sess-1", doc))
    assert run_async(session_cache_module.get_cached_session("sess-1")) == doc

    deadline = time.monotonic() + 3.0
    expired = False
    while time.monotonic() < deadline:
        if run_async(session_cache_module.get_cached_session("sess-1")) is None:
            expired = True
            break
        time.sleep(0.1)
    assert expired, "cached session did not expire within the TTL + generous polling window"


def test_session_cache_keys_are_namespaced():
    assert session_cache_module._key("abc") == "session:abc"


def test_session_cache_get_set_invalidate_are_noop_before_init(monkeypatch):
    monkeypatch.setattr(session_cache_module, "_cache", None)
    assert run_async(session_cache_module.get_cached_session("x")) is None
    run_async(session_cache_module.set_cached_session("x", {"a": 1}))  # must not raise
    run_async(session_cache_module.invalidate_cached_session("x"))  # must not raise


def test_construct_cache_with_retry_succeeds_first_try():
    temp_dir = tempfile.mkdtemp(prefix="bff_test_cache_direct_")
    try:
        import diskcache
        with patch.object(session_cache_module, "CACHE_DIR", temp_dir):
            cache = session_cache_module._construct_cache_with_retry()
            assert isinstance(cache, diskcache.Cache)
            cache.close()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_construct_cache_with_retry_retries_then_succeeds(monkeypatch):
    import diskcache
    real_cache_cls = diskcache.Cache
    attempts = {"n": 0}

    def _flaky_cache(path):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise RuntimeError("database is locked")
        return real_cache_cls(path)

    monkeypatch.setattr(session_cache_module.time, "sleep", lambda s: None)
    monkeypatch.setattr(session_cache_module.diskcache, "Cache", _flaky_cache)
    temp_dir = tempfile.mkdtemp(prefix="bff_test_cache_retry_")
    try:
        with patch.object(session_cache_module, "CACHE_DIR", temp_dir):
            cache = session_cache_module._construct_cache_with_retry()
            assert attempts["n"] == 3
            cache.close()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_construct_cache_with_retry_raises_after_exhausting_attempts(monkeypatch):
    monkeypatch.setattr(session_cache_module.time, "sleep", lambda s: None)
    monkeypatch.setattr(
        session_cache_module.diskcache, "Cache",
        lambda path: (_ for _ in ()).throw(RuntimeError("permanently locked")),
    )
    with pytest.raises(RuntimeError, match="permanently locked"):
        session_cache_module._construct_cache_with_retry()


# =============================================================================
# 11. TESTS: utils/canonical_redirect.py
# =============================================================================
def _make_canonical_app():
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    async def echo(request):
        return PlainTextResponse(f"ok:{request.url.path}")

    app = Starlette(routes=[
        Route("/health", echo), Route("/healthz", echo),
        Route("/some/path", echo), Route("/", echo),
    ])
    app.add_middleware(canonical_redirect_module.CanonicalHostRedirectMiddleware)
    return app


def test_canonical_redirect_passes_through_on_canonical_host():
    app = _make_canonical_app()
    with TestClient(app, base_url="https://canonical.example.com") as c:
        resp = c.get("/some/path", follow_redirects=False)
    assert resp.status_code == 200
    assert resp.text == "ok:/some/path"


def test_canonical_redirect_redirects_known_alt_host():
    app = _make_canonical_app()
    with TestClient(app, base_url="https://alt.example.com") as c:
        resp = c.get("/some/path", follow_redirects=False)
    assert resp.status_code == 307
    assert resp.headers["location"] == "https://canonical.example.com/some/path"


def test_canonical_redirect_preserves_query_string():
    app = _make_canonical_app()
    with TestClient(app, base_url="https://alt.example.com") as c:
        resp = c.get("/some/path?x=1&y=2", follow_redirects=False)
    assert resp.headers["location"] == "https://canonical.example.com/some/path?x=1&y=2"


def test_canonical_redirect_exempts_health_paths():
    app = _make_canonical_app()
    with TestClient(app, base_url="https://alt.example.com") as c:
        resp = c.get("/health", follow_redirects=False)
        resp2 = c.get("/healthz", follow_redirects=False)
    assert resp.status_code == 200
    assert resp2.status_code == 200


def test_canonical_redirect_unknown_host_passes_through_by_default():
    app = _make_canonical_app()
    with TestClient(app, base_url="https://totally-unknown-host.example") as c:
        resp = c.get("/some/path", follow_redirects=False)
    assert resp.status_code == 200


def test_canonical_redirect_unknown_host_rejected_when_configured(monkeypatch):
    monkeypatch.setattr(canonical_redirect_module, "UNKNOWN_HOST_BEHAVIOR", "reject")
    app = _make_canonical_app()
    with TestClient(app, base_url="https://totally-unknown-host.example") as c:
        resp = c.get("/some/path", follow_redirects=False)
    assert resp.status_code == 400


def test_canonical_redirect_honors_x_forwarded_host():
    app = _make_canonical_app()
    with TestClient(app, base_url="https://canonical.example.com") as c:
        resp = c.get("/some/path", headers={"x-forwarded-host": "alt.example.com"}, follow_redirects=False)
    assert resp.status_code == 307
    assert "canonical.example.com" in resp.headers["location"]


def test_is_exempt_wildcard_pattern():
    with patch.object(canonical_redirect_module, "CANONICAL_REDIRECT_EXEMPT_PATHS", {"/health*"}):
        assert canonical_redirect_module._is_exempt("/health") is True
        assert canonical_redirect_module._is_exempt("/health/live") is True
        assert canonical_redirect_module._is_exempt("/other") is False



# =============================================================================
# 12. TESTS: router/cookies.py
# =============================================================================
# def test_set_cookie_route_sets_httponly_secure_cookie(client):
#     resp = client.post("/set-cookie", json={"key": "my_cookie", "value": "my_value"})
#     assert resp.status_code == 200
#     assert resp.json() == {"message": "Cookie set successfully"}
#     set_cookie_header = resp.headers.get("set-cookie", "")
#     assert "my_cookie=my_value" in set_cookie_header
#     assert "httponly" in set_cookie_header.lower()
#     assert "samesite=lax" in set_cookie_header.lower()


# def test_set_cookie_route_never_logs_cookie_value(client, capsys):
#     client.post("/set-cookie", json={"key": "secret_key", "value": "super-secret-value-123"})
#     flush_console_echo(client.app)
#     captured = capsys.readouterr()
#     assert "super-secret-value-123" not in captured.out


# def test_set_cookie_route_logs_only_the_key(client, capsys):
#     client.post("/set-cookie", json={"key": "my_cookie", "value": "anything"})
#     flush_console_echo(client.app)
#     captured = capsys.readouterr()
#     lines = [json.loads(l) for l in captured.out.strip().splitlines() if l.strip().startswith("{")]
#     cookie_events = [l for l in lines if l.get("event") == "bff_cookie_set"]
#     assert len(cookie_events) == 1
#     assert cookie_events[0]["cookie_key"] == "my_cookie"


# def test_set_cookie_route_missing_fields_returns_422(client):
#     resp = client.post("/set-cookie", json={"key": "only_key"})
#     assert resp.status_code == 422


# =============================================================================
# 13. TESTS: router/auth.py -- pure helpers
# =============================================================================
def test_resolve_redirect_uri_accepts_allowed_uri():
    fake_request = SimpleNamespace(
        headers={}, url=SimpleNamespace(scheme="https", hostname="app.example.com"),
    )
    uri = router_auth.resolve_redirect_uri(fake_request)
    assert uri == "https://app.example.com/auth/callback"


def test_resolve_redirect_uri_rejects_unlisted_host():
    fake_request = SimpleNamespace(
        headers={}, url=SimpleNamespace(scheme="https", hostname="evil.example.com"),
    )
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        router_auth.resolve_redirect_uri(fake_request)
    assert exc_info.value.status_code == 400


def test_resolve_redirect_uri_honors_forwarded_headers():
    fake_request = SimpleNamespace(
        headers={"x-forwarded-proto": "https", "x-forwarded-host": "app.example.com"},
        url=SimpleNamespace(scheme="http", hostname="internal-service"),
    )
    uri = router_auth.resolve_redirect_uri(fake_request)
    assert uri == "https://app.example.com/auth/callback"


def test_get_request_origin_falls_back_to_host_header():
    fake_request = SimpleNamespace(
        headers={"host": "app.example.com"}, url=SimpleNamespace(scheme="https", hostname="ignored"),
    )
    scheme, host = router_auth._get_request_origin(fake_request)
    assert scheme == "https"
    assert host == "app.example.com"


def test_msal_app_singleton_constructs_once():
    router_auth._msal_app_singleton = None
    app1 = router_auth.msal_app()
    app2 = router_auth.msal_app()
    assert app1 is app2
    assert isinstance(app1, router_auth.msal.ConfidentialClientApplication)
    assert app1.client_id == router_auth.CLIENT_ID
    assert app1.authority == router_auth.AUTHORITY


def test_msal_app_returns_existing_singleton_without_reconstructing():
    router_auth._msal_app_singleton = None
    app1 = router_auth.msal_app()
    # Replace the singleton with a sentinel and confirm msal_app() returns
    # THAT (proving it doesn't unconditionally rebuild on every call).
    sentinel = object()
    router_auth._msal_app_singleton = sentinel
    assert router_auth.msal_app() is sentinel


def test_store_and_pop_login_flow_round_trip():
    router_auth.container_login_flows = fresh_async_mock_container()
    stored_docs = {}

    async def fake_create_item(doc):
        stored_docs[doc["id"]] = doc

    async def fake_read_item(item, partition_key):
        if item not in stored_docs:
            raise KeyError("not found")
        return stored_docs[item]

    async def fake_delete_item(item, partition_key):
        stored_docs.pop(item, None)

    router_auth.container_login_flows.create_item.side_effect = fake_create_item
    router_auth.container_login_flows.read_item.side_effect = fake_read_item
    router_auth.container_login_flows.delete_item.side_effect = fake_delete_item

    run_async(router_auth.store_login_flow("flow-1", {"auth_uri": "https://x"}))
    result = run_async(router_auth.pop_login_flow("flow-1"))
    assert result == {"auth_uri": "https://x"}
    # one-time use: popped again -> None (already deleted)
    result2 = run_async(router_auth.pop_login_flow("flow-1"))
    assert result2 is None


def test_pop_login_flow_returns_none_when_not_found():
    router_auth.container_login_flows = fresh_async_mock_container()
    router_auth.container_login_flows.read_item.side_effect = Exception("not found")
    result = run_async(router_auth.pop_login_flow("nonexistent"))
    assert result is None


def test_pop_login_flow_swallows_delete_failure():
    router_auth.container_login_flows = fresh_async_mock_container()
    router_auth.container_login_flows.read_item.return_value = {"flow": {"a": 1}}
    router_auth.container_login_flows.delete_item.side_effect = RuntimeError("delete failed")
    result = run_async(router_auth.pop_login_flow("flow-1"))
    assert result == {"a": 1}  # still returns the flow despite delete failure


def test_get_user_oid_success():
    router_auth.container_user = fresh_async_mock_container()
    router_auth.container_user.read_item.return_value = {"user_oid": "oid-123"}
    result = run_async(router_auth.get_user_oid("sess-1"))
    assert result == "oid-123"


def test_get_user_oid_returns_none_on_any_failure():
    router_auth.container_user = fresh_async_mock_container()
    router_auth.container_user.read_item.side_effect = Exception("not found")
    result = run_async(router_auth.get_user_oid("sess-1"))
    assert result is None


def test_get_session_from_cosmos_cache_miss_falls_through_to_cosmos(monkeypatch):
    router_auth.container_user = fresh_async_mock_container()
    router_auth.container_sessions = fresh_async_mock_container()
    router_auth.container_user.read_item.return_value = {"user_oid": "oid-1"}
    doc = make_session_doc(session_id="sess-1", user_oid="oid-1")
    router_auth.container_sessions.read_item.return_value = dict(doc)

    monkeypatch.setattr(router_auth, "get_cached_session", AsyncMock(return_value=None))
    monkeypatch.setattr(router_auth, "set_cached_session", AsyncMock())

    result = run_async(router_auth.get_session_from_cosmos("sess-1"))
    assert result["id"] == "sess-1"
    router_auth.container_sessions.patch_item.assert_awaited_once()


def test_get_session_from_cosmos_cache_hit_skips_cosmos(monkeypatch):
    router_auth.container_user = fresh_async_mock_container()
    router_auth.container_sessions = fresh_async_mock_container()
    cached_doc = make_session_doc(session_id="sess-1")
    monkeypatch.setattr(router_auth, "get_cached_session", AsyncMock(return_value=cached_doc))

    result = run_async(router_auth.get_session_from_cosmos("sess-1"))
    assert result == cached_doc
    router_auth.container_user.read_item.assert_not_called()
    router_auth.container_sessions.read_item.assert_not_called()


def test_get_session_from_cosmos_cache_hit_near_expiry_invalidates_and_refetches(monkeypatch):
    router_auth.container_user = fresh_async_mock_container()
    router_auth.container_sessions = fresh_async_mock_container()
    near_expiry_cached = make_session_doc(session_id="sess-1", user_oid="oid-1", expires_in_minutes=5)  # within the 10-min buffer
    fresh_doc = make_session_doc(session_id="sess-1", user_oid="oid-1", expires_in_minutes=60)

    monkeypatch.setattr(router_auth, "get_cached_session", AsyncMock(return_value=near_expiry_cached))
    invalidate_mock = AsyncMock()
    monkeypatch.setattr(router_auth, "invalidate_cached_session", invalidate_mock)
    monkeypatch.setattr(router_auth, "set_cached_session", AsyncMock())

    router_auth.container_user.read_item.return_value = {"user_oid": "oid-1"}
    router_auth.container_sessions.read_item.return_value = dict(fresh_doc)

    result = run_async(router_auth.get_session_from_cosmos("sess-1"))
    invalidate_mock.assert_awaited_once_with("sess-1")
    assert result["id"] == "sess-1"


def test_get_session_from_cosmos_expired_session_returns_none():
    router_auth.container_user = fresh_async_mock_container()
    router_auth.container_sessions = fresh_async_mock_container()
    router_auth.container_user.read_item.return_value = {"user_oid": "oid-1"}
    expired_doc = make_session_doc(session_id="sess-1", user_oid="oid-1", expires_in_minutes=-60)
    router_auth.container_sessions.read_item.return_value = dict(expired_doc)

    with patch.object(router_auth, "get_cached_session", AsyncMock(return_value=None)):
        result = run_async(router_auth.get_session_from_cosmos("sess-1"))
    assert result is None  # swallowed by the outer try/except -> None


def test_get_session_from_cosmos_no_user_oid_returns_none():
    router_auth.container_user = fresh_async_mock_container()
    router_auth.container_user.read_item.side_effect = Exception("not found")
    with patch.object(router_auth, "get_cached_session", AsyncMock(return_value=None)):
        result = run_async(router_auth.get_session_from_cosmos("sess-1"))
    assert result is None


# =============================================================================
# 14. TESTS: router/auth.py -- HTTP routes
# =============================================================================
def test_login_route_redirects_to_auth_uri_and_sets_flow_cookie(client):
    fake_app = install_fake_msal_app()
    fake_app.initiate_result = {"auth_uri": "https://login.microsoftonline.com/fake-auth-uri-xyz"}

    resp = client.get("/login", follow_redirects=False)
    assert resp.status_code in (302, 307)
    assert resp.headers["location"] == "https://login.microsoftonline.com/fake-auth-uri-xyz"
    assert "login_flow_id" in resp.headers.get("set-cookie", "")
    router_auth.container_login_flows.create_item.assert_awaited_once()


def test_login_route_rejects_unknown_host(client):
    resp = client.get("/login", headers={"host": "evil.example.com"}, follow_redirects=False)
    assert resp.status_code == 400


def test_login_route_returns_401_when_msal_flow_missing_auth_uri(client):
    fake_app = install_fake_msal_app()
    fake_app.initiate_result = {}  # no "auth_uri" key
    resp = client.get("/login", follow_redirects=False)
    assert resp.status_code == 401
    assert resp.json()["error"] == "Failed to build auth URL"


def test_auth_callback_success_creates_session_and_redirects(client):
    fake_app = install_fake_msal_app()
    user_token = make_jwt({"oid": "oid-1", "preferred_username": "alice@example.com"})
    fake_app.acquire_by_flow_result = {"access_token": user_token}
    fake_app.obo_default_result = {"access_token": "obo-tok"}

    router_auth.container_login_flows.read_item.return_value = {"flow": {"state": "abc"}}

    resp = client.get(
        "/auth/callback?code=xyz&state=abc",
        cookies={"login_flow_id": "flow-1"},
        follow_redirects=False,
    )
    assert resp.status_code in (302, 307)
    assert resp.headers["location"] == router_auth.POST_LOGIN_REDIRECT
    assert "session_id" in resp.headers.get("set-cookie", "")
    router_auth.container_sessions.create_item.assert_awaited_once()
    router_auth.container_user.create_item.assert_awaited_once()

    session_doc = router_auth.container_sessions.create_item.call_args.args[0]
    assert session_doc["user_oid"] == "oid-1"
    assert session_doc["username"] == "alice@example.com"
    assert session_doc["user_token"] == user_token
    assert session_doc["foundry_token"] == "obo-tok"
    assert session_doc["speech_token"] == "obo-tok"


def test_auth_callback_no_matching_login_flow_cookie(client):
    resp = client.get("/auth/callback?code=xyz", follow_redirects=False)
    assert resp.status_code == 401
    assert "No matching login" in resp.json()["error"]


def test_auth_callback_flow_not_found_in_store(client):
    router_auth.container_login_flows.read_item.side_effect = Exception("not found")
    resp = client.get("/auth/callback?code=xyz", cookies={"login_flow_id": "missing-flow"}, follow_redirects=False)
    assert resp.status_code == 401


def test_auth_callback_msal_exchange_raises_value_error(client):
    fake_app = install_fake_msal_app()
    fake_app.acquire_by_flow_exception = ValueError("state mismatch")
    router_auth.container_login_flows.read_item.return_value = {"flow": {"state": "abc"}}

    resp = client.get("/auth/callback?code=xyz", cookies={"login_flow_id": "flow-1"}, follow_redirects=False)
    assert resp.status_code == 401
    assert "state mismatch" in resp.json()["error"]


def test_auth_callback_msal_exchange_returns_error_key(client):
    fake_app = install_fake_msal_app()
    fake_app.acquire_by_flow_result = {"error": "invalid_grant", "error_description": "bad code"}
    router_auth.container_login_flows.read_item.return_value = {"flow": {"state": "abc"}}

    resp = client.get("/auth/callback?code=xyz", cookies={"login_flow_id": "flow-1"}, follow_redirects=False)
    assert resp.status_code == 401
    assert resp.json()["error"] == "bad code"


def test_auth_callback_foundry_obo_error_returns_401(client):
    fake_app = install_fake_msal_app()
    user_token = make_jwt({"oid": "oid-1", "preferred_username": "a@b.com"})
    fake_app.acquire_by_flow_result = {"access_token": user_token}
    fake_app.obo_results_by_scope[tuple(router_auth.FOUNDRY_SCOPES)] = {
        "error": "invalid_scope", "error_description": "bad foundry scope",
    }
    router_auth.container_login_flows.read_item.return_value = {"flow": {"state": "abc"}}

    resp = client.get("/auth/callback?code=xyz", cookies={"login_flow_id": "flow-1"}, follow_redirects=False)
    assert resp.status_code == 401
    assert resp.json()["error"] == "bad foundry scope"


def test_get_token_with_session_id_success(client, enable_dev_apis):
    router_auth.get_cached_session = router_auth.get_cached_session  # no-op reference for clarity
    doc = make_session_doc(session_id="sess-1")
    with patch.object(router_auth, "get_cached_session", AsyncMock(return_value=None)):
        router_auth.container_user.read_item.return_value = {"user_oid": doc["user_oid"]}
        router_auth.container_sessions.read_item.return_value = dict(doc)
        resp = client.get("/get_token_with_session_id", cookies={"session_id": "sess-1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["message"] == "Success"
    assert body["sso_token"]["id"] == "sess-1"


def test_get_token_with_session_id_missing_cookie_401(client, enable_dev_apis):
    resp = client.get("/get_token_with_session_id")
    assert resp.status_code == 401


def test_get_token_with_session_id_invalid_session_401(client, enable_dev_apis):
    with patch.object(router_auth, "get_cached_session", AsyncMock(return_value=None)):
        router_auth.container_user.read_item.side_effect = Exception("no such user")
        resp = client.get("/get_token_with_session_id", cookies={"session_id": "bad-session"})
    assert resp.status_code == 401


def test_decoded_user_token_details_route(client, override_session, enable_dev_apis):
    resp = client.get("/decoded_user_token_details")
    assert resp.status_code == 200
    claims = resp.json()
    assert claims["name"] == "Alice Example"


def test_decoded_foundry_token_details_route(client, enable_dev_apis):
    session = SimpleNamespace(sso_token={
        "user_token": make_jwt({"oid": "x"}),
        "foundry_token": make_jwt({"scope": "foundry-scope"}),
        "speech_token": make_jwt({"scope": "speech-scope"}),
    })
    main.app.dependency_overrides[router_auth.get_current_session] = lambda: session
    try:
        resp = client.get("/decoded_foundry_token_details")
        assert resp.status_code == 200
        assert resp.json()["scope"] == "foundry-scope"

        resp2 = client.get("/decoded_speech_token_details")
        assert resp2.status_code == 200
        assert resp2.json()["scope"] == "speech-scope"
    finally:
        main.app.dependency_overrides.pop(router_auth.get_current_session, None)


@pytest.mark.parametrize("path", [
    "/get_token_with_session_id",
    "/decoded_user_token_details",
    "/decoded_foundry_token_details",
    "/decoded_speech_token_details",
])
def test_dev_only_routes_return_404_when_apis_disabled(client, monkeypatch, path):
    monkeypatch.setattr(router_auth, "ENABLE_APIS", False)
    resp = client.get(path, cookies={"session_id": "sess-1"})
    assert resp.status_code == 404


def test_auth_me_success(client):
    with patch.object(router_auth, "get_cached_session", AsyncMock(return_value=make_session_doc())):
        resp = client.post("/auth/me", cookies={"session_id": "sess-1"})
    assert resp.status_code == 200
    assert resp.json()["message"] == "Success"


def test_auth_me_missing_cookie_401(client):
    resp = client.post("/auth/me")
    assert resp.status_code == 401
    assert "session id not found" in resp.json()["detail"]


def test_auth_me_invalid_session_401(client):
    with patch.object(router_auth, "get_cached_session", AsyncMock(return_value=None)):
        router_auth.container_user.read_item.side_effect = Exception("no user")
        resp = client.post("/auth/me", cookies={"session_id": "bad"})
    assert resp.status_code == 401
    assert "token not exist" in resp.json()["detail"]


def test_get_user_details_route(client, override_session):
    resp = client.get("/get_user_details")
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"]["name"] == "Alice Example"
    assert body["data"]["preferred_username"] == "alice@example.com"


def test_logout_route_clears_cookie_and_invalidates_cache(client):
    with patch.object(router_auth, "invalidate_cached_session", AsyncMock()) as invalidate_mock:
        resp = client.post("/logout", cookies={"session_id": "sess-1"})
    assert resp.status_code == 200
    assert resp.json()["message"] == "Success"
    invalidate_mock.assert_awaited_once_with("sess-1")
    # delete_cookie() -> Set-Cookie header clearing session_id
    assert "session_id=" in resp.headers.get("set-cookie", "")


def test_logout_route_without_session_id_still_succeeds(client):
    with patch.object(router_auth, "invalidate_cached_session", AsyncMock()) as invalidate_mock:
        resp = client.post("/logout")
    assert resp.status_code == 200
    invalidate_mock.assert_not_awaited()


# =============================================================================
# 15. TESTS: router/text_chat.py
# =============================================================================
def test_get_conversation_id_success(client, override_session):
    resp = client.get("/api/get_conversation_id")
    assert resp.status_code == 200
    body = resp.json()
    assert body["message"] == "Success"
    assert len(body["conversation_id"]) > 10


def test_get_conversation_id_no_session_401():
    # Bypass override_session -- explicitly force get_current_session to
    # return a falsy value via dependency override, matching the route's
    # own `if not session:` guard.
    main.app.dependency_overrides[router_auth.get_current_session] = lambda: None
    try:
        with TestClient(main.app, base_url="https://app.example.com") as c:
            resp = c.get("/api/get_conversation_id")
        assert resp.status_code == 401
    finally:
        main.app.dependency_overrides.pop(router_auth.get_current_session, None)


def test_proxy_chat_success(client, override_session):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"Bearer {override_session.sso_token['user_token']}"
        assert request.headers["x-foundry-token"] == override_session.sso_token["foundry_token"]
        return httpx.Response(200, json={"agent_response": "hello", "response_id": "resp-1"})

    fake_backend = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    main.app.dependency_overrides[utils_utils.get_http_client] = lambda: fake_backend
    try:
        resp = client.post("/api/chat", json={"user_message": "hi", "previous_response_id": "", "conversation_id": "c1"})
    finally:
        main.app.dependency_overrides.pop(utils_utils.get_http_client, None)
    assert resp.status_code == 200
    assert resp.json()["agent_response"] == "hello"


def test_proxy_chat_no_session_401():
    main.app.dependency_overrides[router_auth.get_current_session] = lambda: None
    try:
        with TestClient(main.app, base_url="https://app.example.com") as c:
            resp = c.post("/api/chat", json={"user_message": "hi", "previous_response_id": "", "conversation_id": "c1"})
        assert resp.status_code == 401
    finally:
        main.app.dependency_overrides.pop(router_auth.get_current_session, None)


def test_proxy_chat_network_error_returns_502(client, override_session):
    def handler(request: httpx.Request):
        raise httpx.ConnectError("connection refused")

    fake_backend = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    main.app.dependency_overrides[utils_utils.get_http_client] = lambda: fake_backend
    try:
        resp = client.post("/api/chat", json={"user_message": "hi", "previous_response_id": "", "conversation_id": "c1"})
    finally:
        main.app.dependency_overrides.pop(utils_utils.get_http_client, None)
    assert resp.status_code == 502
    assert "could not reach backend" in resp.json()["detail"]


def test_proxy_chat_backend_error_status_propagated(client, override_session):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": "rate_limited", "detail": "slow down"})

    fake_backend = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    main.app.dependency_overrides[utils_utils.get_http_client] = lambda: fake_backend
    try:
        resp = client.post("/api/chat", json={"user_message": "hi", "previous_response_id": "", "conversation_id": "c1"})
    finally:
        main.app.dependency_overrides.pop(utils_utils.get_http_client, None)
    assert resp.status_code == 429
    assert resp.json()["detail"] == "rate_limited"


def test_proxy_chat_backend_error_non_json_body(client, override_session):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"plain text failure")

    fake_backend = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    main.app.dependency_overrides[utils_utils.get_http_client] = lambda: fake_backend
    try:
        resp = client.post("/api/chat", json={"user_message": "hi", "previous_response_id": "", "conversation_id": "c1"})
    finally:
        main.app.dependency_overrides.pop(utils_utils.get_http_client, None)
    assert resp.status_code == 500
    assert "plain text failure" in resp.json()["detail"]


def test_proxy_chat_v1_streams_backend_response(client, override_session):
    # NOTE: a MockTransport response built with `content=b"..."` (raw bytes)
    # is marked as ALREADY CONSUMED by httpx -- fine for a plain
    # client.post(...), but `http_client.stream(...)` (used internally by
    # /api/chatV1's proxy code) then raises `httpx.StreamConsumed` trying to
    # iterate it a second time. Passing an ASYNC GENERATOR as `content`
    # instead makes httpx wrap it in a real lazy async byte-stream, which
    # `.stream()` can iterate exactly once, same as a real backend response.
    async def body_chunks():
        yield b'data: {"type": "delta", "content": "Hel"}\n\n'
        yield b'data: {"type": "delta", "content": "lo"}\n\n'

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body_chunks(), headers={"content-type": "text/event-stream"})

    fake_backend = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    main.app.dependency_overrides[utils_utils.get_http_client] = lambda: fake_backend
    try:
        with client.stream(
            "POST", "/api/chatV1",
            json={"user_message": "hi", "previous_response_id": "", "conversation_id": "c1"},
        ) as resp:
            assert resp.status_code == 200
            body = b"".join(resp.iter_raw())
    finally:
        main.app.dependency_overrides.pop(utils_utils.get_http_client, None)
    assert b"Hel" in body
    assert b"lo" in body


def test_proxy_chat_v1_backend_error_yields_error_sse_frame(client, override_session):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"backend exploded")

    fake_backend = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    main.app.dependency_overrides[utils_utils.get_http_client] = lambda: fake_backend
    try:
        with client.stream(
            "POST", "/api/chatV1",
            json={"user_message": "hi", "previous_response_id": "", "conversation_id": "c1"},
        ) as resp:
            body = b"".join(resp.iter_raw())
    finally:
        main.app.dependency_overrides.pop(utils_utils.get_http_client, None)
    assert b'"type": "error"' in body
    assert b"500" in body


def test_proxy_chat_v1_network_error_yields_error_sse_frame(client, override_session):
    def handler(request: httpx.Request):
        raise httpx.ConnectError("refused")

    fake_backend = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    main.app.dependency_overrides[utils_utils.get_http_client] = lambda: fake_backend
    try:
        with client.stream(
            "POST", "/api/chatV1",
            json={"user_message": "hi", "previous_response_id": "", "conversation_id": "c1"},
        ) as resp:
            body = b"".join(resp.iter_raw())
    finally:
        main.app.dependency_overrides.pop(utils_utils.get_http_client, None)
    assert b"bff_proxy_error" in body


def test_proxy_chat_v1_no_session_401():
    main.app.dependency_overrides[router_auth.get_current_session] = lambda: None
    try:
        with TestClient(main.app, base_url="https://app.example.com") as c:
            resp = c.post("/api/chatV1", json={"user_message": "hi", "previous_response_id": "", "conversation_id": "c1"})
        assert resp.status_code == 401
    finally:
        main.app.dependency_overrides.pop(router_auth.get_current_session, None)


# =============================================================================
# 16. TESTS: router/voice_chat.py (/voice/chat websocket relay)
# =============================================================================
def test_receive_init_session_id_valid_frame():
    async def scenario():
        ws = SimpleNamespace(receive_text=AsyncMock(return_value=json.dumps({"type": "init", "session_id": "sess-1"})))
        return await router_voice_chat._receive_init_session_id(ws)
    assert run_async(scenario()) == ("sess-1", None)


def test_receive_init_session_id_wrong_type_returns_none():
    async def scenario():
        ws = SimpleNamespace(receive_text=AsyncMock(return_value=json.dumps({"type": "not_init"})))
        return await router_voice_chat._receive_init_session_id(ws)
    assert run_async(scenario()) is None


def test_receive_init_session_id_bad_json_returns_none():
    async def scenario():
        ws = SimpleNamespace(receive_text=AsyncMock(return_value="not json {{"))
        return await router_voice_chat._receive_init_session_id(ws)
    assert run_async(scenario()) is None


def test_receive_init_session_id_timeout_returns_none(monkeypatch):
    monkeypatch.setattr(router_voice_chat, "INIT_HANDSHAKE_TIMEOUT_S", 0.05)

    async def scenario():
        async def _never_returns():
            await asyncio.sleep(10)
        ws = SimpleNamespace(receive_text=_never_returns)
        return await router_voice_chat._receive_init_session_id(ws)
    assert run_async(scenario()) is None


def test_open_upstream_connection_uses_additional_headers_when_supported():
    captured = {}

    def fake_connect(url, **kwargs):
        captured.update(kwargs)
        captured["url"] = url
        return "connection-object"

    with patch.object(router_voice_chat.websockets, "connect", fake_connect):
        result = router_voice_chat._open_upstream_connection("ws://backend/chat", {"Authorization": "Bearer x"})
    assert result == "connection-object"
    assert captured["url"] == "ws://backend/chat"
    assert "additional_headers" in captured or "extra_headers" in captured


# ---- full websocket relay integration tests (via TestClient.websocket_connect) --
def _voice_headers(session):
    # router/voice_chat.py's route depends on get_current_session (HTTP-style
    # Cookie dependency) even on a WebSocket route -- FastAPI resolves
    # Cookie(...) dependencies from the WebSocket's cookies just like HTTP.
    return {}


def test_voice_relay_missing_tokens_closes_with_1008(client):
    bad_session = SimpleNamespace(sso_token={})  # missing user_token/foundry_token/speech_token
    main.app.dependency_overrides[router_auth.get_current_session] = lambda: bad_session
    try:
        with pytest.raises(Exception):
            with client.websocket_connect("/voice/chat") as ws:
                ws.receive_text()
    finally:
        main.app.dependency_overrides.pop(router_auth.get_current_session, None)


def test_voice_relay_init_handshake_timeout_closes_socket(client, monkeypatch, fake_session):
    monkeypatch.setattr(router_voice_chat, "INIT_HANDSHAKE_TIMEOUT_S", 0.2)
    main.app.dependency_overrides[router_auth.get_current_session] = lambda: fake_session
    try:
        with client.websocket_connect("/voice/chat") as ws:
            # never send the required {"type": "init", ...} frame -- the
            # server sends one clean JSON error frame and then closes.
            error_frame = ws.receive_json()
            assert error_frame["type"] == "error"
            assert "init" in error_frame["message"]
    finally:
        main.app.dependency_overrides.pop(router_auth.get_current_session, None)


def test_voice_relay_full_bidirectional_pump(client, monkeypatch, fake_session):
    upstream = FakeUpstreamWebSocket()
    install_fake_upstream(monkeypatch, upstream)

    main.app.dependency_overrides[router_auth.get_current_session] = (
        lambda: fake_session
    )

    try:
        with client.websocket_connect("/voice/chat") as ws:

            # Browser -> BFF init
            ws.send_text(
                json.dumps({
                    "type": "init",
                    "session_id": "sess-relay-1",
                    "previous_response_id": "1234",
                })
            )

            # Give BFF a moment to establish upstream connection
            # and send the auth frame.
            time.sleep(0.05)

            # --------------------------------------------------
            # Verify BFF -> upstream auth frame
            # --------------------------------------------------

            assert len(upstream.sent) >= 1

            auth_message = json.loads(upstream.sent[0])

            assert auth_message == {
                "type": "auth",
                "backend_token": fake_session.sso_token["user_token"],
                "foundry_token": fake_session.sso_token["foundry_token"],
                "speech_token": fake_session.sso_token["speech_token"],
                "session_id": "sess-relay-1",
                "previous_response_id": "1234"
            }

            # --------------------------------------------------
            # Client -> upstream binary relay
            # --------------------------------------------------

            ws.send_bytes(b"\x01\x02audio-chunk")

            time.sleep(0.05)

            assert upstream.sent[1] == b"\x01\x02audio-chunk"

            # --------------------------------------------------
            # Upstream -> client relay
            # --------------------------------------------------

            client.portal.call(
                upstream.queue_message,
                json.dumps({
                    "type": "agent_text",
                    "text": "hi",
                }),
            )

            received = ws.receive_text()

            assert json.loads(received) == {
                "type": "agent_text",
                "text": "hi",
            }

            # --------------------------------------------------
            # Client disconnects cleanly
            # --------------------------------------------------

            ws.close()

    finally:
        main.app.dependency_overrides.pop(
            router_auth.get_current_session,
            None,
        )

def test_voice_relay_sends_correct_upstream_auth_frame(
    client,
    monkeypatch,
    fake_session,
):
    upstream = FakeUpstreamWebSocket()

    install_fake_upstream(monkeypatch, upstream)

    main.app.dependency_overrides[
        router_auth.get_current_session
    ] = lambda: fake_session

    try:
        with client.websocket_connect("/voice/chat") as ws:

            ws.send_text(
                json.dumps({
                    "type": "init",
                    "session_id": "sess-hdr-1",
                })
            )

            time.sleep(0.05)

            assert len(upstream.sent) >= 1

            auth_message = json.loads(upstream.sent[0])

            assert auth_message["type"] == "auth"

            assert auth_message["backend_token"] == (
                fake_session.sso_token["user_token"]
            )

            assert auth_message["foundry_token"] == (
                fake_session.sso_token["foundry_token"]
            )

            assert auth_message["speech_token"] == (
                fake_session.sso_token["speech_token"]
            )

            assert auth_message["session_id"] == "sess-hdr-1"

            ws.close()

    finally:
        main.app.dependency_overrides.pop(
            router_auth.get_current_session,
            None,
        )


def test_voice_relay_upstream_connect_failure_sends_error_and_closes(client, monkeypatch, fake_session):
    upstream = FakeUpstreamWebSocket(connect_exception=ConnectionRefusedError("no route to host"))
    install_fake_upstream(monkeypatch, upstream)
    main.app.dependency_overrides[router_auth.get_current_session] = lambda: fake_session
    try:
        with client.websocket_connect("/voice/chat") as ws:
            ws.send_text(json.dumps({"type": "init", "session_id": "sess-fail-1"}))
            error_frame = json.loads(ws.receive_text())
            assert error_frame["type"] == "error"
            assert "could not reach voice backend" in error_frame["message"]
    finally:
        main.app.dependency_overrides.pop(router_auth.get_current_session, None)


def test_voice_relay_upstream_closes_first_ends_relay_gracefully(client, monkeypatch, fake_session):
    upstream = FakeUpstreamWebSocket()
    install_fake_upstream(monkeypatch, upstream)
    main.app.dependency_overrides[router_auth.get_current_session] = lambda: fake_session
    try:
        with client.websocket_connect("/voice/chat") as ws:
            ws.send_text(json.dumps({"type": "init", "session_id": "sess-close-1"}))
            client.portal.call(upstream.queue_message, "bye")
            assert ws.receive_text() == "bye"
            client.portal.call(upstream.close_incoming) # upstream ends its side of the conversation
            time.sleep(0.1)
    finally:
        main.app.dependency_overrides.pop(router_auth.get_current_session, None)


def test_watch_scale_in_sends_notice_when_event_set(monkeypatch):
    async def scenario():
        scale_in_event = asyncio.Event()
        fake_ws = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(scale_in_event=scale_in_event)))
        sent = []

        async def fake_send_json_safe(ws, payload):
            sent.append(payload)

        monkeypatch.setattr(router_voice_chat, "_send_json_safe", fake_send_json_safe)
        logger = MagicMock()

        task = asyncio.create_task(
            router_voice_chat._watch_scale_in(fake_ws, "req-1", "sess-1", {"user_oid": "oid-1"}, logger)
        )
        await asyncio.sleep(0.01)
        scale_in_event.set()
        await asyncio.wait_for(task, timeout=2.0)
        return sent, logger

    sent, logger = run_async(scenario())
    assert len(sent) == 1
    assert sent[0]["type"] == "notice"
    assert sent[0]["code"] == "scale_in"
    logger.log.assert_called_once()


def test_watch_scale_in_returns_immediately_when_no_event_on_app_state():
    async def scenario():
        fake_ws = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace()))  # no scale_in_event attr
        logger = MagicMock()
        await router_voice_chat._watch_scale_in(fake_ws, "req-1", "sess-1", {}, logger)
        return logger

    logger = run_async(scenario())
    logger.log.assert_not_called()


# =============================================================================
# 17. TESTS: main.py -- app-level (health, middleware, exception handlers,
#     SPA fallback, lifespan wiring, GracefulWebSocketProtocol)
# =============================================================================
def test_health_endpoint(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_example_endpoint(client):
    resp = client.get("/api/example")
    assert resp.status_code == 200
    assert resp.json() == {"message": "Data from FastAPI backend"}


def test_access_log_middleware_adds_request_id_header(client):
    resp = client.get("/health")
    assert "x-request-id" in resp.headers


def test_access_log_middleware_preserves_client_supplied_request_id(client):
    resp = client.get("/health", headers={"x-request-id": "my-custom-id"})
    assert resp.headers["x-request-id"] == "my-custom-id"


def test_access_log_middleware_logs_non_health_requests(client, capsys):
    client.get("/api/example")
    flush_console_echo(client.app)
    captured = capsys.readouterr()
    lines = [json.loads(l) for l in captured.out.strip().splitlines() if l.strip().startswith("{")]
    access_logs = [l for l in lines if l.get("event") == "bff_http_request" and l.get("path") == "/api/example"]
    assert len(access_logs) == 1
    assert access_logs[0]["status"] == 200
    assert "latency_ms" in access_logs[0]


def test_access_log_middleware_skips_successful_health_polling(client, capsys):
    client.get("/health")
    flush_console_echo(client.app)
    captured = capsys.readouterr()
    lines = [json.loads(l) for l in captured.out.strip().splitlines() if l.strip().startswith("{")]
    health_access_logs = [l for l in lines if l.get("event") == "bff_http_request" and l.get("path") == "/health"]
    assert health_access_logs == []


def test_access_log_middleware_still_logs_failed_health_probe(
    client,
    capsys,
    tmp_path,
    monkeypatch,
):
    # Ensure no index.html exists, even if CI built the real frontend.
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)

    resp = client.get("/healthz")

    assert resp.status_code == 404

    flush_console_echo(client.app)
    captured = capsys.readouterr()

    lines = [
        json.loads(line)
        for line in captured.out.splitlines()
        if line.strip().startswith("{")
    ]

    assert any(
        line.get("path") == "/healthz"
        and line.get("event") == "bff_http_request"
        and line.get("status") == 404
        for line in lines
    )


def test_zap_user_agent_marker_sets_traffic_source(client, capsys):
    client.get("/api/example", headers={"User-Agent": f"scanner/{main.ZAP_UA_MARKER}"})
    flush_console_echo(client.app)
    captured = capsys.readouterr()
    lines = [json.loads(l) for l in captured.out.strip().splitlines() if l.strip().startswith("{")]
    access_logs = [l for l in lines if l.get("event") == "bff_http_request" and l.get("path") == "/api/example"]
    assert access_logs[0].get("traffic_source") == "zap"


def test_zap_header_marker_sets_traffic_source(client, capsys):
    client.get("/api/example", headers={"X-Zap-Scan": "true"})
    flush_console_echo(client.app)
    captured = capsys.readouterr()
    lines = [json.loads(l) for l in captured.out.strip().splitlines() if l.strip().startswith("{")]
    access_logs = [l for l in lines if l.get("event") == "bff_http_request" and l.get("path") == "/api/example"]
    assert access_logs[0].get("traffic_source") == "zap"


def test_non_zap_request_has_no_traffic_source(client, capsys):
    client.get("/api/example")
    flush_console_echo(client.app)
    captured = capsys.readouterr()
    lines = [json.loads(l) for l in captured.out.strip().splitlines() if l.strip().startswith("{")]
    access_logs = [l for l in lines if l.get("event") == "bff_http_request" and l.get("path") == "/api/example"]
    assert "traffic_source" not in access_logs[0]


def test_http_exception_handler_returns_json_and_logs(client, capsys):
    from fastapi import HTTPException

    fake_request = SimpleNamespace(
        app=SimpleNamespace(state=client.app.state),
        state=SimpleNamespace(request_id="req-auth-error"),
        method="GET",
        url=SimpleNamespace(path="/test-auth-error"),
    )

    response = run_async(
        main.http_exception_handler(
            fake_request,
            HTTPException(
                status_code=401,
                detail="Authentication required",
            ),
        )
    )

    assert response.status_code == 401
    assert json.loads(response.body) == {
        "detail": "Authentication required"
    }

    flush_console_echo(client.app)
    captured = capsys.readouterr()

    lines = [
        json.loads(line)
        for line in captured.out.splitlines()
        if line.strip().startswith("{")
    ]

    error_logs = [
        line
        for line in lines
        if line.get("event") == "bff_error"
        and line.get("request_id") == "req-auth-error"
    ]

    assert len(error_logs) == 1
    assert error_logs[0]["status"] == 401
    assert error_logs[0]["error_category"] == "auth_error"


# def test_validation_exception_handler_returns_422_and_logs(client, capsys):
#     resp = client.post("/set-cookie", json={"key": "only-key-no-value"})
#     assert resp.status_code == 422
#     flush_console_echo(client.app)
#     captured = capsys.readouterr()
#     lines = [json.loads(l) for l in captured.out.strip().splitlines() if l.strip().startswith("{")]
#     validation_logs = [l for l in lines if l.get("event") == "bff_error" and l.get("error_category") == "validation_error"]
#     assert len(validation_logs) == 1


def test_unhandled_exception_handler_returns_500_and_logs(client, capsys):
    # NOTE: can't test this by registering a NEW `@main.app.get(...)` route
    # at test time -- main.py's SPA fallback (`@app.get("/{full_path:path}")`)
    # is registered once, at import time, as the LAST route, and FastAPI/
    # Starlette match routes in REGISTRATION ORDER. Any route added later
    # (including from a test) is appended AFTER that catch-all in
    # `app.routes`, so the catch-all -- not the new route -- matches every
    # request first. Calling the handler function directly with a hand-built
    # fake Request (same pattern as `_base_error`'s own tests) exercises the
    # exact same code the real ASGI dispatch would call, without that
    # ordering problem.
    fake_request = SimpleNamespace(
        app=SimpleNamespace(state=client.app.state),
        state=SimpleNamespace(request_id="req-boom"),
        method="GET", url=SimpleNamespace(path="/whatever"),
    )
    resp = run_async(main.unhandled_exception_handler(fake_request, RuntimeError("kaboom")))
    assert resp.status_code == 500
    assert json.loads(resp.body) == {"detail": "Internal server error"}

    flush_console_echo(client.app)
    captured = capsys.readouterr()
    lines = [json.loads(l) for l in captured.out.strip().splitlines() if l.strip().startswith("{")]
    unhandled_logs = [l for l in lines if l.get("event") == "bff_unhandled_error"]
    assert len(unhandled_logs) == 1
    assert "RuntimeError: kaboom" in unhandled_logs[0]["error"]
    assert "traceback" in unhandled_logs[0]


def test_spa_fallback_returns_404_when_no_frontend_build(
    client,
    tmp_path,
    monkeypatch,
):
    # Use an empty directory rather than the actual frontend build.
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)

    resp = client.get("/some/nonexistent/spa/route")

    assert resp.status_code == 404
    assert resp.json() == {"detail": "Frontend build not found"}


def test_spa_fallback_serves_index_html_when_present(client, tmp_path, monkeypatch):
    index_file = tmp_path / "index.html"
    index_file.write_text("<html>fake spa</html>")
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)
    resp = client.get("/whatever/route")
    assert resp.status_code == 200
    assert "fake spa" in resp.text


def test_lifespan_initializes_and_tears_down_all_shared_state():
    with TestClient(main.app, base_url="https://app.example.com") as c:
        assert c.app.state.logger is not None
        assert c.app.state.http_client is not None
        assert isinstance(c.app.state.scale_in_event, asyncio.Event)
        assert router_auth.cosmos_client is not None
        assert session_cache_module._cache is not None
    # After exiting the context, http_client should be closed.
    assert c.app.state.http_client.is_closed is True


def test_scale_in_event_is_a_singleton_across_reimports():
    # Simulates main.py's own hasattr-guarded singleton pattern: re-running
    # the guard logic must NOT construct a second, different Event.
    import uvicorn.protocols.websockets.websockets_impl as ws_impl
    assert hasattr(ws_impl, "_bff_scale_in_event")
    existing = ws_impl._bff_scale_in_event
    if not hasattr(ws_impl, "_bff_scale_in_event"):
        ws_impl._bff_scale_in_event = asyncio.Event()
    assert ws_impl._bff_scale_in_event is existing
    assert main.scale_in_event is existing


def test_graceful_websocket_protocol_shutdown_sets_scale_in_event_once():
    main.scale_in_event.clear()

    class FakeHandshakeEvent:
        def is_set(self):
            return True  # handshake already completed -- active session

    fake_self = SimpleNamespace(
        handshake_completed_event=FakeHandshakeEvent(),
        ws_server=SimpleNamespace(closing=False),
    )
    main.GracefulWebSocketProtocol.shutdown(fake_self)
    assert main.scale_in_event.is_set() is True
    assert fake_self.ws_server.closing is True
    main.scale_in_event.clear()  # reset for any subsequent test


def test_graceful_websocket_protocol_shutdown_closes_transport_pre_handshake():
    main.scale_in_event.clear()

    class FakeHandshakeEvent:
        def is_set(self):
            return False  # NOT yet completed -- safe to reject outright

    calls = []
    fake_self = SimpleNamespace(
        handshake_completed_event=FakeHandshakeEvent(),
        ws_server=SimpleNamespace(closing=False),
        send_500_response=lambda: calls.append("send_500_response"),
        transport=SimpleNamespace(close=lambda: calls.append("transport.close")),
    )
    main.GracefulWebSocketProtocol.shutdown(fake_self)
    assert "send_500_response" in calls
    assert "transport.close" in calls
    main.scale_in_event.clear()


def test_graceful_websocket_protocol_shutdown_logs_via_bff_logger_once(monkeypatch):
    main.scale_in_event.clear()
    import uvicorn.protocols.websockets.websockets_impl as ws_impl
    fake_logger = MagicMock()
    monkeypatch.setattr(ws_impl, "_bff_logger", fake_logger, raising=False)

    class FakeHandshakeEvent:
        def is_set(self):
            return True

    fake_self = SimpleNamespace(handshake_completed_event=FakeHandshakeEvent(), ws_server=SimpleNamespace(closing=False))
    main.GracefulWebSocketProtocol.shutdown(fake_self)
    fake_logger.log.assert_called_once()
    logged = fake_logger.log.call_args.args[0]
    assert logged["event"] == "bff_scale_in_detected"
    main.scale_in_event.clear()


def test_graceful_websocket_protocol_shutdown_swallows_logger_failure(monkeypatch):
    main.scale_in_event.clear()
    import uvicorn.protocols.websockets.websockets_impl as ws_impl
    fake_logger = MagicMock()
    fake_logger.log.side_effect = RuntimeError("logging broke")
    monkeypatch.setattr(ws_impl, "_bff_logger", fake_logger, raising=False)

    class FakeHandshakeEvent:
        def is_set(self):
            return True

    fake_self = SimpleNamespace(handshake_completed_event=FakeHandshakeEvent(), ws_server=SimpleNamespace(closing=False))
    main.GracefulWebSocketProtocol.shutdown(fake_self)  # must not raise
    main.scale_in_event.clear()


def test_ws_protocols_monkeypatch_registers_graceful_protocol():
    assert main.uvicorn.config.WS_PROTOCOLS["websockets"] == "main:GracefulWebSocketProtocol"


def test_base_error_helper_shape():
    fake_request = SimpleNamespace(
        state=SimpleNamespace(request_id="req-1"), method="GET", url=SimpleNamespace(path="/x"),
    )
    result = main._base_error(fake_request, 404, "not_found")
    assert result["event"] == "bff_error"
    assert result["request_id"] == "req-1"
    assert result["status"] == 404
    assert result["error_category"] == "not_found"
    assert result["display_message"] == "The requested resource was not found."


# =============================================================================
# 18. TESTS: main.py -- F1 / F2 / F3 security headers
#     (Content-Security-Policy, Permissions-Policy, anti-clickjacking)
# =============================================================================
def test_permissions_policy_header_present_and_allows_microphone(client):
    resp = client.get("/health")
    pp = resp.headers["permissions-policy"]
    assert "microphone=(self)" in pp          # voice chat needs the mic
    assert "autoplay=(self)" in pp            # TTS replies must be able to play
    assert "camera=()" in pp
    assert "geolocation=()" in pp
    assert "payment=()" in pp
    assert "speaker selection" not in pp      # invalid token with a space


def test_x_frame_options_header_is_sameorigin(client):
    resp = client.get("/health")
    assert resp.headers["x-frame-options"] == "SAMEORIGIN"


def test_csp_report_only_mode_is_default_and_enforces_frame_ancestors(client, monkeypatch):
    monkeypatch.setattr(main, "CSP_MODE", "report-only")
    resp = client.get("/health")
    assert resp.headers["content-security-policy-report-only"] == main.CONTENT_SECURITY_POLICY
    # frame-ancestors is ignored in report-only mode, so it is also enforced on its own.
    assert resp.headers["content-security-policy"] == "frame-ancestors 'self'"


def test_csp_enforce_mode_sends_full_blocking_policy(client, monkeypatch):
    monkeypatch.setattr(main, "CSP_MODE", "enforce")
    resp = client.get("/health")
    assert resp.headers["content-security-policy"] == main.CONTENT_SECURITY_POLICY
    assert "content-security-policy-report-only" not in resp.headers


def test_csp_off_mode_sends_no_csp_header(client, monkeypatch):
    monkeypatch.setattr(main, "CSP_MODE", "off")
    resp = client.get("/health")
    assert "content-security-policy" not in resp.headers
    assert "content-security-policy-report-only" not in resp.headers
    # the other two headers are independent of CSP_MODE
    assert "permissions-policy" in resp.headers
    assert resp.headers["x-frame-options"] == "SAMEORIGIN"


def test_csp_policy_contents():
    csp = main.CONTENT_SECURITY_POLICY
    for directive in (
        "default-src 'self'",
        "script-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-src 'none'",
        "frame-ancestors 'self'",
        "worker-src 'self' blob:",
        "media-src 'self' blob:",
    ):
        assert directive in csp
    assert "'unsafe-eval'" not in csp
    script_src = [d for d in csp.split("; ") if d.startswith("script-src")][0]
    assert "'unsafe-inline'" not in script_src
    # the voice WebSocket host is allowed on connect-src (CANONICAL_HOST from the test env)
    assert "wss://canonical.example.com" in csp


def test_csp_headers_present_on_spa_fallback_and_errors(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CSP_MODE", "enforce")
    index_file = tmp_path / "index.html"
    index_file.write_text("<html>fake spa</html>")
    monkeypatch.setattr(main, "FRONTEND_DIST", tmp_path)
    ok = client.get("/some/spa/route")
    assert ok.status_code == 200
    assert "content-security-policy" in ok.headers
    assert ok.headers["x-frame-options"] == "SAMEORIGIN"
    missing = client.get("/api/does-not-exist")
    assert "content-security-policy" in missing.headers


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_csp_skipped_for_api_docs_paths(client, monkeypatch, path):
    # These paths only exist when ENABLE_APIS=true; they 404 in the suite, but the
    # middleware still runs, so the exemption can be asserted on the 404 response.
    monkeypatch.setattr(main, "CSP_MODE", "enforce")
    resp = client.get(path)
    assert "content-security-policy" not in resp.headers
    assert "content-security-policy-report-only" not in resp.headers
