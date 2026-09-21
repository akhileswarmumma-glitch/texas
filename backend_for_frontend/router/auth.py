"""
BFF (Backend-For-Frontend) Auth & Proxy Service
"""
import os
import uuid
from typing import Optional
import msal
from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from fastapi import APIRouter, Request, HTTPException, Cookie, Depends, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, RedirectResponse
from azure.cosmos.aio import CosmosClient
from datetime import datetime, timedelta, timezone
from models.auth_models import DeleteResponse, SSOToken, SuccessResponse, UserData, UserDetailResponse
from utils.utils import decode_jwt_token
from utils.session_cache import (
    get_cached_session,
    set_cached_session,
    invalidate_cached_session,
)

router = APIRouter(tags=["Auth"])
ENABLE_APIS = os.getenv("ENABLE_APIS", "true").lower() == "true"
KEY_VAULT_NAME = os.environ.get("KEY_VAULT")
KV_URI = f"https://{KEY_VAULT_NAME}.vault.azure.net"

credential = DefaultAzureCredential()
client = SecretClient(vault_url=KV_URI, credential=credential)

CLIENT_ID = client.get_secret(os.environ.get("AAD_CLIENT_ID")).value
CLIENT_SECRET = client.get_secret(os.environ.get("AAD_CLIENT_SECRET")).value
TENANT_ID = client.get_secret(os.environ.get("AAD_TENANT_ID")).value
AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"

REDIRECT_URI = os.environ.get("AAD_REDIRECT_URI", "http://localhost:8000/auth/callback")
_raw_redirect_uris = os.environ.get("AAD_REDIRECT_URIS", REDIRECT_URI)
ALLOWED_REDIRECT_URIS = {
    uri.strip().rstrip("/")
    for uri in _raw_redirect_uris.split(",")
    if uri.strip()
}

FOUNDRY_SCOPES = ["https://ai.azure.com/.default"]
COGNITIVE_SERVICES_SCOPES = ["https://cognitiveservices.azure.com/.default"]

POST_LOGIN_REDIRECT = os.environ.get("POST_LOGIN_REDIRECT", "http://localhost:3000/")
AAD_LOGIN_SCOPES = os.environ.get("AAD_LOGIN_SCOPES", "http://localhost:3000/")
LOGIN_SCOPES = [f"{AAD_LOGIN_SCOPES}-{CLIENT_ID}/access_as_user"]

# How long an in-progress OAuth login flow document lives in the login_flows
# container before TTL reaps it (covers users who abandon login mid-flow).
# NOTE: provision the "login_flows" Cosmos container yourself, matching your
# existing "sessions_user"-style container definitions, with:
#   partition key path = "/id"  (NOT "/session_id" like sessions_user --
#     a login-flow doc is written BEFORE a session_id exists)
#   default_ttl = 600  (matches LOGIN_FLOW_TTL_SECONDS below)
LOGIN_FLOW_TTL_SECONDS = int(os.environ.get("LOGIN_FLOW_TTL_SECONDS", "600"))

COSMOS_ENDPOINT = os.environ.get("COSMOS_ENDPOINT")
COSMOS_DATABASE_NAME = os.environ.get("COSMOS_TOKEN_DATABASE_NAME")

# ---------------------------------------------------------------------------
# Async Cosmos client (azure.cosmos.aio.CosmosClient). Deferred init (see
# init_cosmos() below) because the async credential/transport expect a
# running event loop at construction time -- constructed once from main.py's
# lifespan startup, alongside app.state.http_client and the session cache.
# ---------------------------------------------------------------------------
_cosmos_credential: Optional[AsyncDefaultAzureCredential] = None
cosmos_client: Optional[CosmosClient] = None
container_sessions = None
container_user = None
container_login_flows = None  # dedicated container, see init_cosmos() below


async def init_cosmos() -> None:
    """Call once from main.py's lifespan startup (mirrors app.state.http_client init)."""
    global _cosmos_credential, cosmos_client, container_sessions, container_user, container_login_flows
    _cosmos_credential = AsyncDefaultAzureCredential()
    cosmos_client = CosmosClient(COSMOS_ENDPOINT, credential=_cosmos_credential)
    database = cosmos_client.get_database_client(COSMOS_DATABASE_NAME)
    container_sessions = database.get_container_client("sessions")
    container_user = database.get_container_client("sessions_user")
    # Dedicated container for OAuth login-flow state, partitioned on /id --
    # NOT container_user (partitioned on /session_id, which doesn't exist yet
    # at /login time). See LOGIN_FLOW_TTL_SECONDS comment above for the spec.
    container_login_flows = database.get_container_client("login_flows")


async def aclose_cosmos() -> None:
    """Call once from main.py's lifespan shutdown (mirrors app.state.http_client.aclose())."""
    if cosmos_client is not None:
        await cosmos_client.close()
    if _cosmos_credential is not None:
        await _cosmos_credential.close()


# ---------------------------------------------------------------------------
# Login flow state, persisted in the dedicated login_flows Cosmos container
# (partition key /id) instead of an in-process dict -- required because
# /login and /auth/callback are separate HTTP requests with no guarantee of
# landing on the same worker process or replica once --workers > 1 and/or
# KEDA scales beyond 1 replica.
# ---------------------------------------------------------------------------
async def dev_only():

    if not ENABLE_APIS:
        raise HTTPException(status_code=404) # behaves as if route doesn't exist
    
async def store_login_flow(flow_id: str, flow: dict) -> None:
    doc = {
        "id": flow_id,
        "flow": flow,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "ttl": LOGIN_FLOW_TTL_SECONDS,
    }
    await container_login_flows.create_item(doc)


async def pop_login_flow(flow_id: str) -> Optional[dict]:
    """Read + delete (one-time use), mirroring the old dict.pop() semantics."""
    try:
        doc = await container_login_flows.read_item(item=flow_id, partition_key=flow_id)
    except Exception:
        return None
    try:
        await container_login_flows.delete_item(item=flow_id, partition_key=flow_id)
    except Exception:
        pass  # best-effort cleanup; TTL reaps it regardless if this fails
    return doc.get("flow")


# ---------------------------------------------------------------------------
# msal_app() returns a per-process SINGLETON. MSAL's TokenCache uses an
# internal threading.RLock, so a single shared ConfidentialClientApplication
# instance is safe across concurrent requests within one worker process.
# ---------------------------------------------------------------------------
_msal_app_singleton: Optional[msal.ConfidentialClientApplication] = None


def msal_app() -> msal.ConfidentialClientApplication:
    global _msal_app_singleton
    if _msal_app_singleton is None:
        _msal_app_singleton = msal.ConfidentialClientApplication(
            client_id=CLIENT_ID, client_credential=CLIENT_SECRET, authority=AUTHORITY
        )
    return _msal_app_singleton


def _get_request_origin(request: Request) -> tuple[str, str]:
    """Resolve scheme + host, honoring reverse-proxy / App Gateway / Front Door headers if present."""
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    scheme = forwarded_proto.split(",")[0].strip() if forwarded_proto else request.url.scheme
    host = (
        forwarded_host.split(",")[0].strip()
        if forwarded_host
        else request.headers.get("host", request.url.hostname)
    )
    return scheme, host


def resolve_redirect_uri(request: Request) -> str:
    scheme, host = _get_request_origin(request)
    candidate = f"{scheme}://{host}/auth/callback".rstrip("/")
    if candidate not in ALLOWED_REDIRECT_URIS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Redirect URI '{candidate}' is not in the allowed list. "
                "Add it to AAD_REDIRECT_URIS and to the App Registration's "
                "Redirect URIs if this is expected."
            ),
        )
    return candidate


async def get_user_oid(session_id: str):
    try:
        session_doc = await container_user.read_item(
            item=session_id,
            partition_key=session_id
        )
        user_oid = session_doc["user_oid"]
        return user_oid
    except Exception:
        return None


async def get_session_from_cosmos(session_id: str):
    """
    Checks the local, multi-worker-safe cache (utils/session_cache.py) FIRST.
    On a cache hit, this function does NOT touch Cosmos at all. Only on a
    cache miss does it fall through to the original Cosmos-backed path, and
    then populates the cache for subsequent requests.
    """
    try:
        cached_doc = await get_cached_session(session_id)
        if cached_doc is not None:
            expires_at = datetime.fromisoformat(cached_doc["expires_at"])
            buffer_expiry = expires_at - timedelta(minutes=10)
            if datetime.now(timezone.utc) >= buffer_expiry:
                await invalidate_cached_session(session_id)
            else:
                return cached_doc  # CACHE HIT — no Cosmos call this request

        user_oid = await get_user_oid(session_id)
        if not user_oid:
            raise HTTPException(status_code=401, detail="Session invalid or expired.")
        session_doc = await container_sessions.read_item(
            item=session_id,
            partition_key=user_oid
        )
        expires_at = datetime.fromisoformat(session_doc["expires_at"])
        buffer_expiry = expires_at - timedelta(minutes=10)
        if datetime.now(timezone.utc) >= buffer_expiry:
            raise HTTPException(
                status_code=401,
                detail="Session expired. Please login again."
            )
        current_time = datetime.now(timezone.utc).isoformat()
        await container_sessions.patch_item(
            item=session_id,
            partition_key=user_oid,
            patch_operations=[
                {
                    "op": "replace",
                    "path": "/last_seen",
                    "value": current_time
                }
            ]
        )
        session_doc["last_seen"] = current_time
        await set_cached_session(session_id, session_doc)
        return session_doc
    except Exception:
        return None


@router.get("/login")
async def login(request: Request):
    try:
        redirect_uri = resolve_redirect_uri(request)
        flow = msal_app().initiate_auth_code_flow(scopes=LOGIN_SCOPES, redirect_uri=redirect_uri)
        if "auth_uri" not in flow:
            return JSONResponse(status_code=401, content={"error": "Failed to build auth URL"})
        flow_id = str(uuid.uuid4())
        await store_login_flow(flow_id, flow)
        response = RedirectResponse(flow["auth_uri"])
        response.set_cookie("login_flow_id", flow_id, httponly=True, secure=True, samesite="lax", max_age=3600)
        return response
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"unexpected error while login {error}"
        )


@router.get("/auth/callback")
async def auth_callback(request: Request):
    try:
        flow_id = request.cookies.get("login_flow_id")
        flow = await pop_login_flow(flow_id) if flow_id else None
        if not flow:
            return JSONResponse(status_code=401, content={"error": "No matching login in progress"})
        try:
            result = await run_in_threadpool(
                msal_app().acquire_token_by_auth_code_flow, flow, dict(request.query_params)
            )
        except ValueError as e:
            return JSONResponse(status_code=401, content={"error": str(e)})
        if "error" in result:
            return JSONResponse(status_code=401, content={"error": result.get("error_description")})
        user_token = result["access_token"]
        claims = decode_jwt_token(user_token)
        user_oid = claims["oid"]
        upn = claims.get("preferred_username")
        foundry_result = await run_in_threadpool(
            msal_app().acquire_token_on_behalf_of, user_assertion=user_token, scopes=FOUNDRY_SCOPES
        )
        speech_token = await run_in_threadpool(
            msal_app().acquire_token_on_behalf_of, user_assertion=user_token, scopes=COGNITIVE_SERVICES_SCOPES
        )
        if "error" in foundry_result:
            return JSONResponse(status_code=401, content={"error": foundry_result.get("error_description")})
        session_id = str(uuid.uuid4())
        expiry_time = datetime.now(timezone.utc) + timedelta(minutes=80)
        session_doc = {
            "id": session_id,
            "user_oid": user_oid,
            "username": upn,
            "user_token": user_token,
            "foundry_token": foundry_result.get("access_token"),
            "speech_token": speech_token.get("access_token"),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "last_seen": datetime.now(timezone.utc).isoformat(),
            "expires_at": expiry_time.isoformat(),
            "ttl": 5400
        }
        user_doc = {
            "id": session_id,
            "session_id": session_id,
            "user_oid": user_oid,
            "ttl": 5400
        }
        await container_sessions.create_item(session_doc)
        await container_user.create_item(user_doc)
        response = RedirectResponse(POST_LOGIN_REDIRECT)
        response.set_cookie("session_id", session_id, httponly=True, secure=True, samesite="lax", max_age=3600)
        return response
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {error}"
        )


@router.get("/get_token_with_session_id",dependencies=[Depends(dev_only)])
async def get_current_session(session_id: str = Cookie(None)):
    try:
        if not session_id:
            raise HTTPException(status_code=401, detail="Session invalid or expired.")
        session_doc = await get_session_from_cosmos(session_id)
        if not session_doc:
            raise HTTPException(
                status_code=401,
                detail="Session invalid or expired."
            )
        return SSOToken(message="Success", sso_token=session_doc)
    except HTTPException as e:
        raise e
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Internal server Error: {error}"
        )


@router.get("/decoded_user_token_details",dependencies=[Depends(dev_only)])
async def decode_token_deatils(token: str = Depends(get_current_session)):
    try:
        token_resp = decode_jwt_token(token.sso_token.get("user_token"))
        return token_resp
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Internal server Error: {error}"
        )


@router.get("/decoded_foundry_token_details",dependencies=[Depends(dev_only)])
async def decode_token_deatils(token: str = Depends(get_current_session)):
    try:
        token_resp = decode_jwt_token(token.sso_token.get("foundry_token"))
        return token_resp
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Internal server Error: {error}"
        )


@router.get("/decoded_speech_token_details",dependencies=[Depends(dev_only)])
async def decode_token_deatils(token: str = Depends(get_current_session)):
    try:
        token_resp = decode_jwt_token(token.sso_token.get("speech_token"))
        return token_resp
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Internal server Error: {error}"
        )


@router.post("/auth/me")
async def verify_auth(session_id: str = Cookie(None)):
    if not session_id:
        raise HTTPException(
            status_code=401,
            detail=f"Auth failed as session id not found"
        )
    session_token = await get_session_from_cosmos(session_id)
    if not session_token:
        raise HTTPException(
            status_code=401,
            detail=f"Auth failed as token not exist in cosmos"
        )
    return SuccessResponse(message="Success")


@router.get("/get_user_details")
async def get_user_details(token: str = Depends(get_current_session)):
    try:
        token_resp = decode_jwt_token(token.sso_token.get("user_token"))
        if token_resp:
            return UserDetailResponse(message="Success", data=UserData(
                name=token_resp.get("name"),
                preferred_username=token_resp.get("preferred_username")
            ))
        raise HTTPException(
            status_code=404, detail="token details not found"
        )
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Internal server Error: {error}"
        )


@router.post("/logout")
async def logout(response: Response, session_id: str = Cookie(None)):
    if session_id:
        await invalidate_cached_session(session_id)
    response.delete_cookie(
        key="session_id",
        path="/"
    )
    return DeleteResponse(message="Success")
