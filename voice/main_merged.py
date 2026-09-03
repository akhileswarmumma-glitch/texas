"""
main.py — Chat backend: browser mic -> STT -> Foundry Agent (text) -> TTS -> browser.

Architecture (per spec):
    1. Client opens ws://.../chat -> the socket is accepted, then the client MUST
       authenticate before anything else happens (see "Auth model" below). Only once
       authentication succeeds is a session created and held server-side for the
       lifetime of that connection.
    2. Client clicks the mic once and sends {"type": "start_listening"}. The backend
       starts a continuous Speech-to-Text recognizer against a live PushAudioInputStream
       and streams "listening" status back.
    3. Client streams raw PCM16 mono audio as binary WebSocket frames continuously
       while listening is on; each chunk is written straight into the push stream as
       it arrives (no buffering — the SDK's own voice-activity/endpoint detection
       decides where one utterance ends and the next begins).
    4. Every time the recognizer finalizes an utterance (Speech SDK's `recognized`
       event), the backend sends the transcript to the client for display, then sends
       that text to the Foundry agent (Responses API, text in / text out — NOT Voice
       Live) — all without the client sending any further per-utterance message.
    5. Backend runs the agent's reply through Text-to-Speech and sends the audio back,
       along with the reply text and that response's id. Recognition keeps running the
       whole time, so the next utterance can start as soon as the user talks again.
    6. Client sends {"type": "stop_listening"} (second mic click) or disconnects to
       tear the recognizer and push stream down.

Conversation continuity — previous_response_id chaining, not a server-side "conversation"
object:
    Each turn calls responses.create(input=text, previous_response_id=...), chaining to
    the prior turn's response.id instead of creating/holding a separate conversation
    resource. ChatSession.last_response_id carries this between turns for the life of
    one WebSocket connection — it starts at None on a fresh connection, so a new
    connection always starts a fresh agent context (no continuity across reconnects).

Barge-in:
    The moment the user starts talking again — Speech SDK's interim `recognizing`
    event, which fires before the phrase is even finished — cancels whatever turn is
    currently in flight (the agent/TTS pipeline for the *previous* utterance) and/or
    tells the client to stop any agent audio that's playing. This does NOT touch the
    continuous recognizer itself, which keeps running throughout the whole listening
    session; only the downstream agent+TTS turn / playback gets cancelled.

    The server's turn task finishes as soon as it *sends* the agent_audio message —
    long before the client is done playing a multi-second clip — so "is a turn in
    flight" alone isn't enough to know whether the user is barging in on live
    playback. The client acks {"type": "playback_started"} when it starts playing a
    clip and {"type": "playback_ended"} when it finishes naturally; the server tracks
    this as ChatSession._agent_speaking and treats it as an equally valid barge-in
    target alongside an in-flight turn task.

    This is turn-level barge-in: it can't interrupt a blocking Speech SDK call
    mid-flight (the SDK calls run in a worker thread and keep running to completion in
    the background), but it guarantees the *user* never has to wait for a stale turn
    or stale playback, and stale results are discarded rather than sent to the client
    or logged.

Perceived-latency filler (interim "thinking" audio):
    If the agent hasn't answered within FILLER_DELAY_S (default 2s) of a turn starting,
    the backend synthesizes and sends ONE short filler phrase (randomly picked from
    FILLER_PHRASES, avoiding an immediate repeat) over the *same* agent_audio channel
    used for real replies — so client-side playback/barge-in tracking treats it
    identically to a real answer. The real agent call keeps running in the background
    the whole time (no timeout on it, same as always); once it completes, its
    agent_text + TTS'd agent_audio are sent as normal. Sending a new agent_audio message
    naturally supersedes whatever's currently playing on the client (existing src-swap
    behavior), so the filler gets cut short and the real answer starts immediately —
    no special client-side handling is needed for that transition. No agent_text is
    ever sent for the filler, so it never appears in the client's transcript/log —
    it's audio-only, purely to mask perceived latency.

OAuth Identity Passthrough (consent):
    The Foundry agent authenticates its downstream tools (e.g. a ServiceNow MCP
    server) using OAuth Identity Passthrough. The first time a user hits a tool that
    needs their delegated consent, the agent does NOT answer — instead its Responses
    output contains an `oauth_consent_request` item carrying a `consent_link`. When we
    see that, we:
        * send the client a {"type": "consent", "link": ...} control frame so the UI
          can render the clickable authorization link,
        * SPEAK a short "please authorize…" prompt back over TTS (through the normal
          agent_audio channel, so playback/barge-in tracking works exactly like any
          other turn),
        * skip the normal answer for that turn, but still log it (flagged
          consent_required=True) and still chain last_response_id forward so the next
          real utterance continues the same agent context.
    Detecting the consent item requires AIProjectClient(..., allow_preview=True).

Session logging:
    Every session gets its own JSON transcript at SESSION_LOG_DIR/<session_id>.json,
    rewritten atomically after every turn, containing the user text, agent text, and
    token usage for that turn. The same information is also printed to the terminal
    as it happens.

Auth model — PER-REQUEST TOKENS + MANDATORY JWT VALIDATION (no bypass switch):
    Nothing is hardcoded. Every connection MUST carry THREE Entra access tokens, which
    are validated / used per-session.

      * backend_token  — an access token for THIS API. We fully validate it as a JWT
                         (signature via JWKS, audience, issuer, tenant, expiry, and the
                         required `access_as_user` scope) and derive the caller's oid/upn.
      * foundry_token  — the user's delegated token for Microsoft Foundry (audience
                         https://ai.azure.com). Used to build a per-session
                         AIProjectClient via StaticTokenCredential. Because Foundry uses
                         OAuth Identity Passthrough, this MUST be the end-user's token.
      * speech_token   — the user's delegated token for Cognitive Services (audience
                         https://cognitiveservices.azure.com). The Speech SDK doesn't
                         accept a bare Entra token, so per Microsoft's documented pattern
                         we build "aad#<speech-resource-ARM-ID>#<token>" per call.

    How the tokens reach the server:
        * Browsers CANNOT set custom WebSocket headers, so the primary path is a first
          JSON frame after connect:
              {"type":"auth","backend_token":"...","foundry_token":"...","speech_token":"...","session_id":"..."}
        * For non-browser clients (curl/tests/server-to-server — this now includes our
          own BFF, which sits in front of this service and is the only caller browsers
          talk to) the same three values may instead be supplied as headers:
          Authorization: Bearer <backend_token>, X-Foundry-Token, X-Speech-Token. If all
          three headers are present we use them and skip waiting for the auth frame.

    Session id — supplied by the caller, not generated here:
        The BFF (and therefore, transitively, the browser) mints one session_id per
        logical conversation and passes it through so the SAME id is used end-to-end
        (frontend -> BFF -> this backend), which keeps BFF-side logs, this service's
        SESSION_LOG_DIR transcripts, and any client-side session tracking all keyed the
        same way. It's read from the X-Session-Id header on the header-auth path, or
        from "session_id" in the auth frame on the frame-auth path. If neither supplies
        one (e.g. an old/ad-hoc client), we fall back to generating a fresh uuid4 so the
        service still works standalone.

    Secrets/config source — Azure Key Vault (via managed identity), not plain env vars:
        KEY_VAULT_NAME (env) points at the vault; AZURE_TENANT_ID and
        BACKEND_API_AUDIENCE are read from Key Vault secrets at startup (the secret
        *names* come from the AAD_TENANT_ID / AAD_CLIENT_ID env vars). The app fails
        fast at startup if any of this — or the Foundry/Speech resource config below —
        is missing.

    NOTE: the per-session speech_token is captured once, at connect time, and is used
    for the whole listening session without being refreshed. A listening session that
    outlives that token's validity (Entra tokens are typically ~60-90 min) will start
    failing with `canceled` events on the recognizer. There is currently no
    client-driven "refresh_speech_token" message; if long-lived sessions are expected,
    add one.

Install:
    pip install -r requirements.txt

Run:
    uvicorn main:app --host 0.0.0.0 --port 3001 --reload
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import random
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

import azure.cognitiveservices.speech as speechsdk
import jwt
from azure.ai.projects import AIProjectClient
from azure.core.credentials import AccessToken
from azure.identity import DefaultAzureCredential
from azure.cosmos import CosmosClient
from azure.cosmos.exceptions import CosmosResourceNotFoundError, CosmosHttpResponseError
# from azure.keyvault.secrets import SecretClient
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from jwt import PyJWKClient
from jwt.exceptions import (
    ExpiredSignatureError,
    InvalidAudienceError,
    InvalidIssuerError,
    InvalidTokenError,
)
from pydantic import BaseModel

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("chat-backend")

# --------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------

# Credential used ONLY to reach Key Vault (managed identity in Azure, falls back to
# whatever else DefaultAzureCredential can resolve locally, e.g. `az login`).
# credential = DefaultAzureCredential(managed_identity_client_id=os.environ.get("AZURE_CLIENT_ID"))

KEY_VAULT_NAME = os.getenv("KEY_VAULT_NAME")
KV_URI = f"https://{KEY_VAULT_NAME}.vault.azure.net" if KEY_VAULT_NAME else ""
# _kv_client: Optional[SecretClient] = SecretClient(vault_url=KV_URI, credential=credential) if KV_URI else None

def _get_secret(env_var_holding_secret_name: str) -> str:
    """Reads the Key Vault *secret name* out of an env var, then fetches that secret's
    value from the vault. Returns "" if anything along the way is missing, so startup
    validation (below) can report every missing piece at once instead of crashing on
    the first one."""
    secret_name = os.environ.get(env_var_holding_secret_name)
    if not (_kv_client and secret_name):
        return ""
    try:
        return _kv_client.get_secret(secret_name).value or ""
    except Exception:
        log.exception("failed to read Key Vault secret referenced by %s", env_var_holding_secret_name)
        return ""


# AAD_TENANT_ID / AAD_CLIENT_ID are env vars holding the *names* of the Key Vault
# secrets that in turn hold the tenant id / backend API audience (client id or
# api://... URI) — nothing sensitive is stored directly in the environment.
# AZURE_TENANT_ID = _get_secret("AAD_TENANT_ID")
# BACKEND_API_AUDIENCE = _get_secret("AAD_CLIENT_ID")

AZURE_TENANT_ID = "79c0f8d9-f033-4471-8268-c49ae7dfa1b2"
BACKEND_API_AUDIENCE = "2a067f64-f874-4fde-be95-31e47ae7c38e"


log.info("AZURE_TENANT_ID resolved: %s", "yes" if AZURE_TENANT_ID else "MISSING")
log.info("BACKEND_API_AUDIENCE resolved: %s", "yes" if BACKEND_API_AUDIENCE else "MISSING")

BACKEND_API_SCOPE = "access_as_user"

EXPECTED_ISSUER = f"https://login.microsoftonline.com/{AZURE_TENANT_ID}/v2.0" if AZURE_TENANT_ID else ""
JWKS_URL = (
    f"https://login.microsoftonline.com/{AZURE_TENANT_ID}/discovery/v2.0/keys"
    if AZURE_TENANT_ID
    else ""
)

# JWKS client is cached process-wide (keys rotate rarely; cached for 5 min). Built
# lazily/guarded — if AZURE_TENANT_ID is missing this stays None and startup validation
# below will refuse to serve traffic rather than fail confusingly on first request.
_jwk_client: Optional[PyJWKClient] = (
    PyJWKClient(JWKS_URL, cache_jwk_set=True, lifespan=300) if JWKS_URL else None
)

# Seconds to wait for the client's first {"type":"auth"} frame before giving up.
AUTH_HANDSHAKE_TIMEOUT_S = float(os.environ.get("AUTH_HANDSHAKE_TIMEOUT_S", "10"))

# ---- Speech / Foundry resource config -------------------------------------------------

SPEECH_REGION = os.environ.get("SPEECH_REGION", "eastus2")
SPEECH_RESOURCE_ID = os.environ.get("SPEECH_RESOURCE_ID", "/subscriptions/937541b3-eea9-41f7-911e-88b256c1efe4/resourceGroups/txrh-rg-RoadieRangerDev-6279-StoSup-pHmO-speech-service/providers/Microsoft.CognitiveServices/accounts/txrh-spch-RoadieRangerDev-6279-StoSup-pHmO")  # full ARM resource ID
SPEECH_ENDPOINT = os.environ.get("SPEECH_ENDPOINT", "https://roadierangerdev-6279-stosup-phmo.cognitiveservices.azure.com/")
SPEECH_RECOGNITION_LANGUAGE = os.environ.get("SPEECH_RECOGNITION_LANGUAGE", "en-US")
SPEECH_SYNTHESIS_VOICE = os.environ.get("SPEECH_SYNTHESIS_VOICE", "en-US-AvaNeural")

# Audio format the FRONTEND must send: raw PCM16 mono at this sample rate.
INPUT_SAMPLE_RATE = int(os.environ.get("INPUT_SAMPLE_RATE", "16000"))

FOUNDRY_PROJECT_ENDPOINT = os.environ.get("PROJECT_ENDPOINT", "https://txrh-aif-roadierangerdev-6279-stosup-phmo-standard.services.ai.azure.com/api/projects/txrh-proj-RoadieRangerDev-6279-StoSup-pHmO-standard-default")
FOUNDRY_AGENT_NAME = os.environ.get("AGENT_NAME", "Text-Agent")

# Cosmos DB configuration. The same managed identity credential used by this
# service is used to authenticate to Cosmos DB.

COSMOS_ENDPOINT = os.environ.get("COSMOS_ENDPOINT", "")
COSMOS_DATABASE_NAME = os.environ.get("COSMOS_DATABASE_NAME", "")
CONVERSATIONS_CONTAINER_NAME = "conversations"
TURNS_CONTAINER_NAME = "turns"

ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

# Spoken back over TTS when the agent asks for OAuth consent.
CONSENT_PROMPT_TEXT = (
    "To continue, please authorize access to your account using the link on your "
    "screen. Once you've done that, come back and ask me again."
)

# Perceived-latency filler: how long to wait after "thinking" starts before playing a
# filler phrase, if the real agent answer hasn't arrived yet. See module docstring.
FILLER_DELAY_S = float(os.environ.get("FILLER_DELAY_S", "2.0"))

# Pool of short filler phrases spoken (audio-only, never shown as agent_text) while the
# agent is still thinking past FILLER_DELAY_S. Picked at random per turn, avoiding an
# immediate repeat of the previous one within the same session (see
# ChatSession._pick_filler_text).
FILLER_PHRASES = [
    "Hmm, let me think about that for a moment.",
    "Good question, give me just a second.",
    "Let me look into that for you.",
    "One moment, I'm working on it.",
    "Just a sec, pulling that together.",
]

# Where per-session transcript+token JSON logs are written.
SESSION_LOG_DIR = Path(os.environ.get("SESSION_LOG_DIR", "session_logs"))
SESSION_LOG_DIR.mkdir(parents=True, exist_ok=True)

# Cosmos DB clients. These are process-wide and thread-safe.
# cosmos_client = CosmosClient(COSMOS_ENDPOINT, credential=credential)
# database = cosmos_client.get_database_client(COSMOS_DATABASE_NAME)
# conversations_container = database.get_container_client(CONVERSATIONS_CONTAINER_NAME)
# turns_container = database.get_container_client(TURNS_CONTAINER_NAME)

# Upper bound on how long a single turn's TTS synthesis may take before we give up on
# it and tell the client, rather than leaving them stuck on "synthesizing" indefinitely.
# Cancelling the await here does NOT stop the underlying blocking SDK call running in
# its worker thread (same limitation as barge-in — see module docstring) — it only
# stops us from waiting on it any longer.
#
# The agent call has NO timeout, deliberately — the agent is allowed to take as long
# as it needs to think; only barge-in (the user talking again) cuts it off.
TTS_CALL_TIMEOUT_S = float(os.environ.get("TTS_CALL_TIMEOUT_S", "15"))


# --------------------------------------------------------------------------------------
# Auth: models, errors, token validation
# --------------------------------------------------------------------------------------

class AuthenticatedUser(BaseModel):
    oid: str
    upn: str
    tenant_id: str
    scopes: set[str]
    claims: Dict[str, Any]


class AuthError(Exception):
    """Raised when the backend token is missing or fails validation. `code` is a short
    machine-readable reason sent to the client before the socket is closed."""

    def __init__(self, message: str, code: str = "unauthorized") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


class StaticTokenCredential:
    """Minimal TokenCredential that always returns a pre-supplied Entra access token.

    AIProjectClient / the OpenAI client only ever call `.get_token(*scopes)` and read
    `.token` off the result, so this is enough to feed them the user's delegated
    Foundry token (OAuth Identity Passthrough). The reported expiry is cosmetic — the
    real expiry is baked into the JWT itself."""

    def __init__(self, token: str) -> None:
        self._token = token

    def get_token(self, *scopes: str, **kwargs: Any) -> AccessToken:
        return AccessToken(self._token, int(time.time()) + 3600)

    def close(self) -> None:  # AIProjectClient calls close() on shutdown
        pass


def _startup_auth_config_check() -> None:
    """Fail fast at startup if any mandatory config is incomplete — auth, Foundry, or
    Speech — instead of only surfacing an error deep inside the first WebSocket
    session."""
    missing = []
    if not AZURE_TENANT_ID:
        missing.append("AZURE_TENANT_ID (Key Vault secret named by AAD_TENANT_ID)")
    if not BACKEND_API_AUDIENCE:
        missing.append("BACKEND_API_AUDIENCE (Key Vault secret named by AAD_CLIENT_ID)")
    if not FOUNDRY_PROJECT_ENDPOINT:
        missing.append("PROJECT_ENDPOINT")
    if not FOUNDRY_AGENT_NAME:
        missing.append("AGENT_NAME")
    if not SPEECH_ENDPOINT:
        missing.append("SPEECH_ENDPOINT")
    if not SPEECH_RESOURCE_ID:
        missing.append("SPEECH_RESOURCE_ID")
    if missing:
        raise RuntimeError(
            "Mandatory config is missing/unresolved: " + ", ".join(missing) +
            ". Set these before starting the service."
        )
    if _jwk_client is None:
        # Should be unreachable given the check above, but guard anyway.
        raise RuntimeError("JWKS client was not initialised (AZURE_TENANT_ID missing).")
    log.info(
        "Backend JWT validation enabled (tenant=%s, audience=%s, scope=%s)",
        AZURE_TENANT_ID, BACKEND_API_AUDIENCE, BACKEND_API_SCOPE,
    )


def validate_backend_token(token: str) -> AuthenticatedUser:
    """Validate the caller's backend access token and return the authenticated user.

    Signature via JWKS, audience, issuer, tenant, expiry/nbf/iat, and the required
    scope are all checked. Authentication is mandatory: every token is fully
    verified. On any failure an AuthError is raised and the socket is closed."""
    token = (token or "").strip()
    if not token:
        raise AuthError("backend token is required", code="missing_token")

    try:
        signing_key = _jwk_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            jwt=token,
            key=signing_key.key,
            algorithms=["RS256"],
            audience=BACKEND_API_AUDIENCE,
            issuer=EXPECTED_ISSUER,
            leeway=60,
            options={
                "require": ["exp", "iat", "nbf", "iss", "aud", "tid", "oid"],
                "verify_signature": True,
                "verify_exp": True,
                "verify_nbf": True,
                "verify_iat": True,
                "verify_iss": True,
                "verify_aud": True,
            },
        )
    except ExpiredSignatureError:
        raise AuthError("access token has expired", code="token_expired")
    except InvalidAudienceError:
        raise AuthError("access token has an invalid audience", code="invalid_audience")
    except InvalidIssuerError:
        raise AuthError("access token has an invalid issuer", code="invalid_issuer")
    except InvalidTokenError:
        raise AuthError("access token is invalid", code="invalid_token")
    except Exception as ex:
        log.warning("token validation failure: %s: %s", type(ex).__name__, ex)
        raise AuthError("unable to validate access token", code="validation_failed")

    if claims.get("tid") != AZURE_TENANT_ID:
        raise AuthError("access token belongs to an unauthorized tenant", code="wrong_tenant")

    user_oid = claims.get("oid")
    user_upn = claims.get("preferred_username") or claims.get("upn") or claims.get("email")
    if not user_oid:
        raise AuthError("access token does not contain oid", code="missing_oid")
    if not user_upn:
        raise AuthError("access token does not contain a username claim", code="missing_upn")

    scopes = {s for s in (claims.get("scp") or "").split() if s}
    if BACKEND_API_SCOPE not in scopes:
        raise AuthError("caller does not have the required API scope", code="missing_scope")

    return AuthenticatedUser(
        oid=user_oid,
        upn=user_upn,
        tenant_id=claims.get("tid"),
        scopes=scopes,
        claims=claims,
    )


# --------------------------------------------------------------------------------------
# STT (continuous) / TTS helpers — per-session delegated speech token; SDK calls are
# blocking, so run them in a thread.
# --------------------------------------------------------------------------------------

def _new_speech_config(speech_auth_token: str) -> speechsdk.SpeechConfig:
    cfg = speechsdk.SpeechConfig(endpoint=SPEECH_ENDPOINT)
    # REQUIRED format: the Speech service does not accept a bare Entra token — per
    # Microsoft's documented Entra-auth pattern we build "aad#<resourceId>#<token>".
    cfg.authorization_token = f"aad#{SPEECH_RESOURCE_ID}#{speech_auth_token}"
    cfg.speech_recognition_language = SPEECH_RECOGNITION_LANGUAGE
    cfg.speech_synthesis_voice_name = SPEECH_SYNTHESIS_VOICE
    return cfg


def _start_continuous_recognition_sync(recognizer: speechsdk.SpeechRecognizer) -> None:
    recognizer.start_continuous_recognition_async().get()


def _stop_continuous_recognition_sync(recognizer: speechsdk.SpeechRecognizer) -> None:
    recognizer.stop_continuous_recognition_async().get()


def _synthesize_sync(text: str, speech_auth_token: str) -> Optional[bytes]:
    cfg = _new_speech_config(speech_auth_token)
    cfg.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3
    )
    # audio_config=None -> don't play to a local speaker (there isn't one on a server);
    # the synthesized bytes come back on result.audio_data instead.
    synthesizer = speechsdk.SpeechSynthesizer(speech_config=cfg, audio_config=None)
    result = synthesizer.speak_text_async(text).get()

    if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
        return result.audio_data
    if result.reason == speechsdk.ResultReason.Canceled:
        details = result.cancellation_details
        log.error("TTS canceled: %s / %s", details.reason, details.error_details)
        return None
    return None


async def text_to_speech(text: str, speech_auth_token: str) -> Optional[bytes]:
    if not text:
        return None
    return await asyncio.to_thread(_synthesize_sync, text, speech_auth_token)


# --------------------------------------------------------------------------------------
# Foundry agent call (text in / text out, Responses API — not Voice Live).
# Multi-turn continuity via previous_response_id chaining — see module docstring.
# Also detects OAuth Identity Passthrough consent requests (see module docstring).
# --------------------------------------------------------------------------------------

def _usage_to_dict(usage) -> dict:
    """Normalizes whatever `.usage` shape the Responses API gives back into a plain
    dict. Different SDK versions/backends have used input_tokens/output_tokens vs
    prompt_tokens/completion_tokens, so we check both rather than assuming."""
    if usage is None:
        return {"input_tokens": None, "output_tokens": None, "total_tokens": None}

    def _get(*names):
        for name in names:
            val = getattr(usage, name, None)
            if val is not None:
                return val
        return None

    input_tokens = _get("input_tokens", "prompt_tokens")
    output_tokens = _get("output_tokens", "completion_tokens")
    total_tokens = _get("total_tokens")
    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = input_tokens + output_tokens

    input_details = getattr(usage, "input_tokens_details", None)
    output_details = getattr(usage, "output_tokens_details", None)

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "cached_tokens": getattr(input_details, "cached_tokens", None) if input_details else None,
        "cache_write_tokens": getattr(input_details, "cache_write_tokens", None) if input_details else None,
        "reasoning_tokens": getattr(output_details, "reasoning_tokens", None) if output_details else None,
    }


def find_consent_item(response) -> Optional[dict]:
    """Return the `oauth_consent_request` item if the Foundry agent emitted one
    (OAuth Identity Passthrough), else None."""
    try:
        if isinstance(response, dict):
            items = response.get("output") or []
        else:
            items = response.model_dump().get("output") or []
    except Exception:
        return None

    for item in items:
        if isinstance(item, dict) and item.get("type") == "oauth_consent_request":
            return item
    return None


def _ask_agent_sync(
    openai_client, text: str, previous_response_id: Optional[str]
) -> tuple[str, str, dict, Optional[str], dict, Optional[str]]:
    """Returns (output_text, response_id, tokens, consent_link). consent_link is None
    unless the agent emitted an oauth_consent_request item, in which case
    output_text is "" and the caller must not treat this as a normal answer."""
    kwargs: dict = {"input": text}
    if previous_response_id:
        kwargs["previous_response_id"] = previous_response_id
    response = openai_client.responses.create(**kwargs)
    tokens = _usage_to_dict(getattr(response, "usage", None))
    response_details = {"model": getattr(response, "model", None), **tokens}
    ticket_number = extract_created_incident_info(response).get("ticket_number")

    consent = find_consent_item(response)
    if consent:
        return "", response.id, tokens, str(consent.get("consent_link") or ""), response_details, ticket_number
    return response.output_text, response.id, tokens, None, response_details, ticket_number


async def ask_agent(
    openai_client, text: str, previous_response_id: Optional[str]
) -> tuple[str, str, dict, Optional[str], dict, Optional[str]]:
    return await asyncio.to_thread(_ask_agent_sync, openai_client, text, previous_response_id)


def _build_foundry_clients(foundry_token: str):
    """Build a per-session AIProjectClient (as the end user, via their delegated
    token) plus its agent-scoped OpenAI client. allow_preview=True is REQUIRED for
    the oauth_consent_request item to surface."""
    foundry_credential = StaticTokenCredential(foundry_token)
    project_client = AIProjectClient(
        endpoint=FOUNDRY_PROJECT_ENDPOINT,
        credential=foundry_credential,
        allow_preview=True,
    )
    openai_client = project_client.get_openai_client(agent_name=FOUNDRY_AGENT_NAME)
    return foundry_credential, project_client, openai_client


# --------------------------------------------------------------------------------------
# Cosmos DB write helpers
# --------------------------------------------------------------------------------------

def extract_created_incident_info(response) -> Dict[str, Any]:
    """Extract a ServiceNow incident number/sys_id from a create_incident MCP call."""
    result = {
        "create_incident_called": False,
        "ticket_number": None,
        "sys_id": None,
        "tool_status": None,
    }
    for item in getattr(response, "output", []) or []:
        if getattr(item, "type", None) != "mcp_call" or getattr(item, "name", None) != "create_incident":
            continue
        result["create_incident_called"] = True
        result["tool_status"] = getattr(item, "status", None)
        output_text = getattr(item, "output", "") or ""
        try:
            match = re.search(r'\{\s*"structuredResponse"\s*:\s*\{.*?\}\s*\}', output_text, re.DOTALL)
            if match:
                structured = json.loads(match.group(0)).get("structuredResponse", {})
                result["ticket_number"] = structured.get("number")
                result["sys_id"] = structured.get("sys_id")
                return result
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
        number_match = re.search(r"\bINC\d+\b", output_text)
        sys_id_match = re.search(r'"sys_id"\s*:\s*"([^"]+)"', output_text)
        if number_match:
            result["ticket_number"] = number_match.group(0)
        if sys_id_match:
            result["sys_id"] = sys_id_match.group(1)
        return result
    return result


def patch_or_upsert_conversation(
    user_oid: str, user_upn: str, conversation_id: str, ticket_number: Optional[str], now: str
) -> None:
    patch_operations = [{"op": "replace", "path": "/last_activity_time", "value": now}]
    if ticket_number:
        patch_operations.append({"op": "add", "path": "/ticket_numbers/-", "value": ticket_number})
    try:
        conversations_container.patch_item(
            item=conversation_id,
            partition_key=user_oid,
            patch_operations=patch_operations,
        )
    except CosmosResourceNotFoundError:
        conversations_container.upsert_item({
            "id": conversation_id,
            "user_oid": user_oid,
            "user_upn": user_upn,
            "channel": "text",
            "start_time": now,
            "last_activity_time": now,
            "conversation_id": conversation_id,
            "ticket_numbers": [ticket_number] if ticket_number else [],
            "voice_session": True,
        })
    except CosmosHttpResponseError as exc:
        raise RuntimeError(f"Failed to patch conversation document: {exc}") from exc


def insert_turn_documents(
    user_oid: str,
    conversation_id: str,
    user_message: str,
    agent_response: str,
    current_response_id: str,
    response_details: Dict[str, Any],
    now: str,
) -> None:
    user_turn_doc = {
        "id": f"{current_response_id}_user",
        "conversation_id": conversation_id,
        "user_oid": user_oid,
        "role": "user",
        "message_text": user_message,
        "run_id": current_response_id,
        "turn_id": current_response_id,
        "channel": "text",
        "created_at": now,
    }
    agent_turn_doc = {
        "id": f"{current_response_id}_agent",
        "conversation_id": conversation_id,
        "user_oid": user_oid,
        "role": "agent",
        "message_text": agent_response,
        "run_id": current_response_id,
        "turn_id": current_response_id,
        "channel": "text",
        "created_at": now,
        "model": response_details.get("model"),
        "input_tokens": response_details.get("input_tokens"),
        "output_tokens": response_details.get("output_tokens"),
        "total_tokens": response_details.get("total_tokens"),
        "cached_tokens": response_details.get("cached_tokens"),
        "cache_write_tokens": response_details.get("cache_write_tokens"),
        "reasoning_tokens": response_details.get("reasoning_tokens"),
    }
    turns_container.create_item(user_turn_doc)
    turns_container.create_item(agent_turn_doc)


def persist_turn_to_cosmos(
    *, user_oid: str, user_upn: str, conversation_id: str, user_message: str,
    agent_response: str, response_id: str, response_details: Dict[str, Any],
    ticket_number: Optional[str], now: str,
) -> None:
    patch_or_upsert_conversation(
        user_oid, user_upn, conversation_id, ticket_number, now
    )
    insert_turn_documents(
        user_oid, conversation_id, user_message, agent_response,
        response_id, response_details, now
    )


# --------------------------------------------------------------------------------------
# SessionLogger — per-session JSON transcript + token usage, plus terminal echo
# --------------------------------------------------------------------------------------

class SessionLogger:
    """Owns one JSON file per session under SESSION_LOG_DIR. The file is rewritten
    (atomically, via a temp-file + rename) after every turn, so it's always valid
    JSON on disk even if the process dies mid-session — no partial/corrupt writes."""

    def __init__(
        self,
        session_id: str,
        user_oid: Optional[str] = None,
        user_upn: Optional[str] = None,
    ) -> None:
        self.session_id = session_id
        self.user_oid = user_oid
        self.user_upn = user_upn
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.ended_at: Optional[str] = None
        self.turns: list[dict] = []
        self.path = SESSION_LOG_DIR / f"{session_id}.json"
        self._lock = asyncio.Lock()

    def _snapshot(self) -> dict:
        return {
            "session_id": self.session_id,
            "user_oid": self.user_oid,
            "user_upn": self.user_upn,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "turn_count": len(self.turns),
            "turns": self.turns,
        }

    def _write_sync(self, data: dict) -> None:
        tmp_path = self.path.with_suffix(".json.tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        tmp_path.replace(self.path)  # atomic rename on the same filesystem

    async def _flush(self) -> None:
        data = self._snapshot()
        async with self._lock:
            await asyncio.to_thread(self._write_sync, data)

    async def log_turn(
        self,
        *,
        user_text: str,
        agent_text: str,
        tokens: dict,
        latency_ms: int,
        interrupted: bool = False,
        consent_required: bool = False,
        consent_link: Optional[str] = None,
        filler_played: bool = False,
    ) -> None:
        turn = {
            "turn": len(self.turns) + 1,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "user_text": user_text,
            "agent_text": agent_text,
            "tokens": tokens,
            "latency_ms": latency_ms,
            "interrupted": interrupted,
            "consent_required": consent_required,
            "consent_link": consent_link,
            "filler_played": filler_played,
        }
        self.turns.append(turn)
        await self._flush()
        self._print_turn(turn)

    def _print_turn(self, turn: dict) -> None:
        t = turn["tokens"] or {}
        short_id = self.session_id[:8]
        who = self.user_upn or "unknown"
        print(f"\n[{short_id}] {who}  turn {turn['turn']}  {turn['timestamp']}  ({turn['latency_ms']} ms)")
        print(f"  You:   {turn['user_text']}")
        if turn.get("consent_required"):
            print(f"  Agent: [CONSENT REQUIRED] {turn.get('consent_link')}")
        else:
            print(f"  Agent: {turn['agent_text']}")
        if turn.get("filler_played"):
            print(f"  [perceived-latency filler was played before this answer]")
        print(
            f"  Tokens: input={t.get('input_tokens')}  "
            f"output={t.get('output_tokens')}  total={t.get('total_tokens')}"
        )

    async def close(self) -> None:
        self.ended_at = datetime.now(timezone.utc).isoformat()
        await self._flush()
        log.info("[%s] session log finalized: %s", self.session_id, self.path)


# --------------------------------------------------------------------------------------
# ChatSession — one per WebSocket connection, lives for its duration
# --------------------------------------------------------------------------------------

class ChatSession:
    def __init__(
        self,
        session_id: str,
        ws: WebSocket,
        user: AuthenticatedUser,
        foundry_token: str,
        speech_token: str,
    ) -> None:
        self.session_id = session_id
        self.ws = ws
        self.user = user
        # Captured once at connect time — see the "NOTE" on refreshing in the module
        # docstring's Auth model section.
        self.speech_token = speech_token

        # The prior turn's response.id, chained into the next call via
        # previous_response_id. None until the first successful turn on this
        # connection — a new connection always starts a fresh agent context.
        self.last_response_id: Optional[str] = None
        self.logger = SessionLogger(session_id, user_oid=user.oid, user_upn=user.upn)

        # Per-session Foundry clients, built from the user's delegated token (OAuth
        # Identity Passthrough) with allow_preview=True so consent items surface.
        self._foundry_credential, self._project_client, self._openai_client = (
            _build_foundry_clients(foundry_token)
        )

        # The task currently running the agent -> TTS pipeline for a turn, if any.
        # Tracked so a fresh recognizing (barge-in) event can cancel it.
        self._current_turn_task: Optional[asyncio.Task] = None

        # Continuous-recognition plumbing.
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._event_queue: asyncio.Queue = asyncio.Queue()
        self._event_consumer_task: Optional[asyncio.Task] = None
        self._recognizer: Optional[speechsdk.SpeechRecognizer] = None
        self._push_stream: Optional[speechsdk.audio.PushAudioInputStream] = None
        self._listening = False

        # True while the CLIENT is actually playing back agent audio. This is distinct
        # from `_current_turn_task` being in flight: that task finishes as soon as the
        # agent_audio message is *sent*, long before the client is done playing a
        # multi-second clip. Without this, barge-in only worked during "thinking"/
        # "synthesizing" and silently no-op'd for the (common) case of the user talking
        # over actual audio playback. Driven by playback_started/playback_ended acks
        # from the client (see run()).
        self._agent_speaking = False

        # Index into FILLER_PHRASES last used for this session's perceived-latency
        # filler, so consecutive fillers (across different turns) don't repeat the
        # same phrase back-to-back. None until the first filler is played.
        self._last_filler_index: Optional[int] = None

    async def _send(self, msg: dict) -> None:
        try:
            await self.ws.send_json(msg)
        except Exception:
            pass

    async def init(self) -> None:
        await self._send({
            "type": "session_ready",
            "session_id": self.session_id,
            "user_oid": self.user.oid,
            "user_upn": self.user.upn,
        })
        # Establish the log file on disk immediately (0 turns) so it exists for the
        # full lifetime of the session, not just once a turn completes.
        await self.logger._flush()

    def append_audio(self, chunk: bytes) -> None:
        if self._push_stream is not None:
            self._push_stream.write(chunk)
        # else: not currently listening (start/stop race) — drop.

    # ---- continuous recognition: SDK-thread callbacks -> asyncio bridge --------------

    def _queue_event(self, event: dict) -> None:
        """Called on the Speech SDK's own worker thread. Only plain values are put on
        the queue — never SDK objects — since they're about to cross a thread
        boundary. call_soon_threadsafe + put_nowait is a lightweight, non-blocking
        handoff onto the session's asyncio loop."""
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._event_queue.put_nowait, event)

    def _build_recognizer(self) -> None:
        stream_format = speechsdk.audio.AudioStreamFormat(
            samples_per_second=INPUT_SAMPLE_RATE, bits_per_sample=16, channels=1
        )
        self._push_stream = speechsdk.audio.PushAudioInputStream(stream_format)
        audio_config = speechsdk.audio.AudioConfig(stream=self._push_stream)
        # TODO: self.speech_token is the user's delegated token, captured once at
        # connect time and never refreshed for the life of this recognizer. A
        # listening session that runs longer than the token's ~60-90 min validity
        # will start failing with `canceled` events — see module docstring.
        self._recognizer = speechsdk.SpeechRecognizer(
            speech_config=_new_speech_config(self.speech_token), audio_config=audio_config
        )

        def _on_recognizing(evt: speechsdk.SpeechRecognitionEventArgs) -> None:
            self._queue_event({"type": "recognizing"})

        def _on_recognized(evt: speechsdk.SpeechRecognitionEventArgs) -> None:
            text = evt.result.text if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech else None
            self._queue_event({"type": "recognized", "text": text})

        def _on_canceled(evt: speechsdk.SpeechRecognitionCanceledEventArgs) -> None:
            details = f"{evt.cancellation_details.reason} / {evt.cancellation_details.error_details}"
            self._queue_event({"type": "canceled", "details": details})

        self._recognizer.recognizing.connect(_on_recognizing)
        self._recognizer.recognized.connect(_on_recognized)
        self._recognizer.canceled.connect(_on_canceled)

    async def _consume_recognition_events(self) -> None:
        while True:
            event = await self._event_queue.get()
            kind = event["type"]
            if kind == "recognizing":
                await self._on_interim()
            elif kind == "recognized":
                text = event.get("text")
                if text:
                    self._start_turn_task(text)
            elif kind == "canceled":
                log.error("[%s] continuous recognition canceled: %s", self.session_id, event.get("details"))
                await self._send({"type": "error", "message": "speech recognition error"})

    async def _on_interim(self) -> None:
        """Fires the instant the user starts talking again (Speech SDK's interim
        `recognizing` event) — even while a previous turn is still "thinking" or
        "synthesizing", or while the client is playing back agent audio. Cancels the
        in-flight turn (if any) and/or tells the client to stop playback (if any) so
        the user isn't kept waiting on, and never receives, a response to an utterance
        they've already moved past. Does NOT touch the recognizer/push stream —
        recognition keeps running throughout the whole listening session."""
        turn_running = self._current_turn_task is not None and not self._current_turn_task.done()
        if not turn_running and not self._agent_speaking:
            return

        log.info("[%s] barge-in: interim speech detected (turn_running=%s, agent_speaking=%s)",
                  self.session_id, turn_running, self._agent_speaking)
        if turn_running:
            self._current_turn_task.cancel()
        self._agent_speaking = False
        await self._send({"type": "status", "text": "interrupted"})

    # ---- listening lifecycle ----------------------------------------------------------

    async def handle_start_listening(self) -> None:
        if self._listening:
            return
        self._build_recognizer()
        await asyncio.to_thread(_start_continuous_recognition_sync, self._recognizer)
        self._listening = True
        await self._send({"type": "status", "text": "listening"})
        log.info("[%s] continuous recognition started", self.session_id)

    async def handle_stop_listening(self) -> None:
        if not self._listening:
            return
        self._listening = False
        try:
            await asyncio.to_thread(_stop_continuous_recognition_sync, self._recognizer)
        except Exception:
            log.exception("[%s] error stopping continuous recognition", self.session_id)
        if self._push_stream is not None:
            self._push_stream.close()
        self._recognizer = None
        self._push_stream = None
        await self._send({"type": "status", "text": "idle"})
        log.info("[%s] continuous recognition stopped", self.session_id)

    # ---- turn processing (agent + TTS) -------------------------------------------------

    def _on_turn_task_done(self, task: asyncio.Task) -> None:
        if task.cancelled():
            log.info("[%s] turn task cancelled (barge-in)", self.session_id)
            return
        exc = task.exception()
        if exc is not None:
            log.exception("[%s] turn task failed", self.session_id, exc_info=exc)

    async def _handle_consent(
        self, *, user_text: str, consent_link: str, tokens: dict, start_time: float,
        response_id: str, response_details: Dict[str, Any], ticket_number: Optional[str]
    ) -> None:
        """Agent asked for OAuth consent instead of answering. Tell the UI, speak a
        short prompt back through the normal agent_audio channel (so playback acks /
        barge-in tracking behave exactly like any other turn), log the turn, and stop
        — no normal answer this turn."""
        log.info("[%s] agent requires OAuth consent", self.session_id)

        await self._send({"type": "consent", "link": consent_link, "text": CONSENT_PROMPT_TEXT})
        await self._send({"type": "agent_text", "text": CONSENT_PROMPT_TEXT})

        await self._send({"type": "status", "text": "synthesizing"})
        try:
            audio = await asyncio.wait_for(
                text_to_speech(CONSENT_PROMPT_TEXT, self.speech_token), timeout=TTS_CALL_TIMEOUT_S
            )
        except asyncio.TimeoutError:
            log.error("[%s] TTS call timed out after %.0fs", self.session_id, TTS_CALL_TIMEOUT_S)
            audio = None
        except Exception:
            log.exception("[%s] TTS call failed", self.session_id)
            audio = None

        if audio:
            await self._send({
                "type": "agent_audio",
                "format": "mp3",
                "audio_base64": base64.b64encode(audio).decode(),
            })
        else:
            await self._send({"type": "error", "message": "speech synthesis failed"})

        await self._send({"type": "status", "text": "ready"})

        latency_ms = int((time.monotonic() - start_time) * 1000)
        now = datetime.now(timezone.utc).isoformat()
        # try:
        #     await asyncio.to_thread(
        #         persist_turn_to_cosmos,
        #         user_oid=self.user.oid, user_upn=self.user.upn,
        #         conversation_id=self.session_id, user_message=user_text,
        #         agent_response=CONSENT_PROMPT_TEXT, response_id=response_id,
        #         response_details=response_details, ticket_number=ticket_number, now=now,
        #     )
        # except Exception:
        #     log.exception("[%s] failed to persist consent turn to Cosmos DB", self.session_id)
        #     await self._send({"type": "error", "message": "response generated but Cosmos DB persistence failed"})
        await self.logger.log_turn(
            user_text=user_text,
            agent_text=CONSENT_PROMPT_TEXT,
            tokens=tokens,
            latency_ms=latency_ms,
            consent_required=True,
            consent_link=consent_link,
        )

    def _pick_filler_text(self) -> str:
        """Pick a random perceived-latency filler phrase, best-effort avoiding an
        immediate repeat of the one used last on this session."""
        if len(FILLER_PHRASES) <= 1:
            return FILLER_PHRASES[0]
        choices = [i for i in range(len(FILLER_PHRASES)) if i != self._last_filler_index]
        idx = random.choice(choices)
        self._last_filler_index = idx
        return FILLER_PHRASES[idx]

    async def _play_filler_audio(self) -> None:
        """Synthesizes and sends ONE filler phrase over the normal agent_audio channel
        to mask perceived latency while the real agent call is still in flight past
        FILLER_DELAY_S. Deliberately sends NO agent_text — the filler is audio-only
        and must never appear in the client's transcript/log. If the real answer's
        agent_audio arrives while this filler is still playing, the client's existing
        agent_audio handler swaps `src` and calls play() again, which naturally cuts
        the filler short and starts the real answer immediately — no special
        client-side handling is required for that interruption. Failures here are
        swallowed (logged only) rather than failing the turn — worst case the user
        just doesn't get the filler and waits a bit longer for the real answer."""
        text = self._pick_filler_text()
        log.info(
            "[%s] agent still thinking after %.1fs — playing filler: %r",
            self.session_id, FILLER_DELAY_S, text,
        )
        try:
            audio = await asyncio.wait_for(
                text_to_speech(text, self.speech_token), timeout=TTS_CALL_TIMEOUT_S
            )
        except asyncio.TimeoutError:
            log.error("[%s] filler TTS call timed out after %.0fs", self.session_id, TTS_CALL_TIMEOUT_S)
            return
        except Exception:
            log.exception("[%s] filler TTS call failed", self.session_id)
            return

        if audio:
            await self._send({
                "type": "agent_audio",
                "format": "mp3",
                "audio_base64": base64.b64encode(audio).decode(),
            })

    async def _process_turn(self, user_text: str) -> None:
        start_time = time.monotonic()

        await self._send({"type": "user_text", "text": user_text})

        await self._send({"type": "status", "text": "thinking"})

        # No timeout on the agent call itself, deliberately — the agent may take as
        # long as it needs; only barge-in (self._current_turn_task.cancel()) cuts it
        # off. It's wrapped in its own task so we can race it against FILLER_DELAY_S:
        # if it hasn't finished by then, we play one filler phrase (audio-only, masks
        # perceived latency) while continuing to wait for the real answer in the
        # background — see module docstring's "Perceived-latency filler" section.
        agent_task = asyncio.create_task(
            ask_agent(self._openai_client, user_text, self.last_response_id)
        )
        filler_played = False
        try:
            done, _pending = await asyncio.wait({agent_task}, timeout=FILLER_DELAY_S)
            if agent_task not in done:
                await self._play_filler_audio()
                filler_played = True
                agent_text, response_id, tokens, consent_link, response_details, ticket_number = await agent_task
            else:
                agent_text, response_id, tokens, consent_link = agent_task.result()
        except asyncio.CancelledError:
            # Barge-in: stop waiting on the real answer too. Same limitation as any
            # other blocking SDK/HTTP call here — cancelling doesn't kill work already
            # running on its worker thread, it just stops us from waiting on it.
            agent_task.cancel()
            raise
        except Exception:
            # Covers Exception, not (Base)CancelledError, so a barge-in cancellation
            # still propagates and isn't mistaken for an agent failure.
            log.exception("[%s] agent call failed", self.session_id)
            await self._send({"type": "error", "message": "agent request failed"})
            await self._send({"type": "status", "text": "ready"})
            return
        finally:
            if not agent_task.done():
                agent_task.cancel()

        # Chain the next turn off this response. Only updated on success — a barge-in
        # cancellation or failure above leaves the last known-good id in place, so a
        # discarded turn can never break continuity for the one after it. This holds
        # whether the turn was a normal answer or an OAuth consent request — either
        # way response_id is a valid id to chain from.
        self.last_response_id = response_id

        # OAuth Identity Passthrough: agent returned a consent request, not an answer.
        if consent_link:
            await self._handle_consent(
                user_text=user_text, consent_link=consent_link, tokens=tokens, start_time=start_time,
                response_id=response_id, response_details=response_details, ticket_number=ticket_number
            )
            return

        await self._send({"type": "agent_text", "text": agent_text, "response_id": response_id})

        await self._send({"type": "status", "text": "synthesizing"})
        try:
            audio = await asyncio.wait_for(
                text_to_speech(agent_text, self.speech_token), timeout=TTS_CALL_TIMEOUT_S
            )
        except asyncio.TimeoutError:
            log.error("[%s] TTS call timed out after %.0fs", self.session_id, TTS_CALL_TIMEOUT_S)
            audio = None
        except Exception:
            log.exception("[%s] TTS call failed", self.session_id)
            audio = None

        latency_ms = int((time.monotonic() - start_time) * 1000)

        if audio:
            # Sent as a JSON control message with base64 payload so it can't be
            # confused with an inbound binary audio frame on the same socket.
            await self._send({
                "type": "agent_audio",
                "format": "mp3",
                "audio_base64": base64.b64encode(audio).decode(),
            })
        else:
            await self._send({"type": "error", "message": "speech synthesis failed"})

        await self._send({"type": "status", "text": "ready"})

        # Persist the completed voice turn using the same two-container schema as
        # backend_text_code.py. The WebSocket session id is the conversation id.
        now = datetime.now(timezone.utc).isoformat()
        # try:
        #     await asyncio.to_thread(
        #         persist_turn_to_cosmos,
        #         user_oid=self.user.oid, user_upn=self.user.upn,
        #         conversation_id=self.session_id, user_message=user_text,
        #         agent_response=agent_text, response_id=response_id,
        #         response_details=response_details, ticket_number=ticket_number, now=now,
        #     )
        # except Exception:
        #     log.exception("[%s] failed to persist turn to Cosmos DB", self.session_id)
        #     await self._send({"type": "error", "message": "response generated but Cosmos DB persistence failed"})

        # If we get here the turn completed normally (wasn't cancelled) — log it.
        await self.logger.log_turn(
            user_text=user_text,
            agent_text=agent_text,
            tokens=tokens,
            latency_ms=latency_ms,
            filler_played=filler_played,
        )

    def _start_turn_task(self, user_text: str) -> None:
        # Defensive: if somehow a turn task is still running, cancel it first so we
        # never have two turns racing to send responses on the same socket.
        if self._current_turn_task is not None and not self._current_turn_task.done():
            self._current_turn_task.cancel()

        task = asyncio.create_task(self._process_turn(user_text))
        task.add_done_callback(self._on_turn_task_done)
        self._current_turn_task = task

    async def run(self) -> None:
        self._loop = asyncio.get_running_loop()
        await self.init()
        self._event_consumer_task = asyncio.create_task(self._consume_recognition_events())
        try:
            while True:
                message = await self.ws.receive()

                if message["type"] == "websocket.disconnect":
                    break

                if message.get("bytes") is not None:
                    self.append_audio(message["bytes"])
                    continue

                if message.get("text") is not None:
                    try:
                        control = json.loads(message["text"])
                    except json.JSONDecodeError:
                        continue

                    msg_type = control.get("type")
                    if msg_type == "start_listening":
                        await self.handle_start_listening()
                    elif msg_type == "stop_listening":
                        await self.handle_stop_listening()
                    elif msg_type == "playback_started":
                        self._agent_speaking = True
                    elif msg_type == "playback_ended":
                        self._agent_speaking = False
                    elif msg_type == "ping":
                        await self._send({"type": "pong"})
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("[%s] session error", self.session_id)
            await self._send({"type": "error", "message": "internal server error"})
        finally:
            await self.close()

    async def close(self) -> None:
        await self.handle_stop_listening()
        if self._event_consumer_task is not None:
            self._event_consumer_task.cancel()
        if self._current_turn_task is not None and not self._current_turn_task.done():
            self._current_turn_task.cancel()
        try:
            self._project_client.close()
        except Exception:
            pass
        try:
            self._foundry_credential.close()
        except Exception:
            pass
        await self.logger.close()
        log.info("[%s] session ended", self.session_id)


# --------------------------------------------------------------------------------------
# WebSocket auth handshake helpers
# --------------------------------------------------------------------------------------

def _tokens_from_headers(ws: WebSocket) -> Optional[tuple[str, str, str, Optional[str]]]:
    """Non-browser clients (e.g. the BFF) may supply tokens as headers. Returns
    (backend, foundry, speech, session_id) only if all three TOKENS are present, else
    None (so we fall back to the auth frame). session_id is optional even on this path
    — if the caller doesn't send X-Session-Id we simply return None for it and the
    caller falls back to generating a fresh uuid4."""
    auth_hdr = ws.headers.get("authorization")
    foundry = ws.headers.get("x-foundry-token")
    speech = ws.headers.get("x-speech-token")
    if not (auth_hdr and foundry and speech):
        return None
    backend = auth_hdr[7:].strip() if auth_hdr.lower().startswith("bearer ") else auth_hdr.strip()
    session_id = (ws.headers.get("x-session-id") or "").strip() or None
    return backend, foundry, speech, session_id


async def _tokens_from_first_frame(ws: WebSocket) -> tuple[str, str, str, Optional[str]]:
    """Browser path: wait for the first {"type":"auth", ...} JSON frame and pull the
    three tokens (and optional session_id) out of it. Raises AuthError on timeout /
    malformed / missing tokens."""
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=AUTH_HANDSHAKE_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise AuthError("timed out waiting for auth frame", code="auth_timeout")
    except WebSocketDisconnect:
        raise AuthError("client disconnected before authenticating", code="disconnected")

    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        raise AuthError("first frame must be JSON of type 'auth'", code="bad_auth_frame")

    if msg.get("type") != "auth":
        raise AuthError("first frame must have type 'auth'", code="bad_auth_frame")

    backend = (msg.get("backend_token") or "").strip()
    foundry = (msg.get("foundry_token") or "").strip()
    speech = (msg.get("speech_token") or "").strip()
    session_id = (msg.get("session_id") or "").strip() or None

    if not backend:
        raise AuthError("auth frame missing backend_token", code="missing_token")
    if not foundry:
        raise AuthError("auth frame missing foundry_token", code="missing_foundry_token")
    if not speech:
        raise AuthError("auth frame missing speech_token", code="missing_speech_token")

    return backend, foundry, speech, session_id


async def _authenticate(ws: WebSocket) -> tuple[AuthenticatedUser, str, str, Optional[str]]:
    """Resolve the three tokens + optional session_id (headers first, then
    first-frame) and validate the backend token. Returns (user, foundry_token,
    speech_token, session_id) — session_id is None if the caller didn't supply one,
    in which case chat_endpoint() falls back to generating a fresh uuid4."""
    creds = _tokens_from_headers(ws)
    if creds is None:
        creds = await _tokens_from_first_frame(ws)
    backend_token, foundry_token, speech_token, session_id = creds

    user = validate_backend_token(backend_token)
    return user, foundry_token, speech_token, session_id


# --------------------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------------------

app = FastAPI(
    title="Azure AI Foundry Voice Chat API",
    version="1.0.0",
    description="FastAPI backend for Azure AI Foundry Agent voice chat "
                 "(continuous STT -> Foundry Agent -> TTS over WebSocket).",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Active sessions, keyed by session_id — useful for introspection/metrics; the
# session's actual lifetime is tied to its WebSocket connection, not this dict.
active_sessions: dict[str, ChatSession] = {}


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "active_sessions": len(active_sessions)}


@app.get("/health")
async def health():
    """Liveness/health probe for Container Apps ingress."""
    return {"status": "ok"}


@app.on_event("startup")
async def startup() -> None:
    _startup_auth_config_check()
    log.info("session logs will be written to: %s", SESSION_LOG_DIR.resolve())


@app.on_event("shutdown")
async def shutdown() -> None:
    # Close every still-open session (flushing its log) so nothing is lost on a clean
    # shutdown.
    for session in list(active_sessions.values()):
        try:
            await session.close()
        except Exception:
            log.exception("[%s] failed to close session on shutdown", session.session_id)
    cosmos_client.close()
    credential.close()  # sync credential -> sync close, not awaitable


@app.websocket("/chat")
async def chat_endpoint(ws: WebSocket):
    await ws.accept()

    # ---- Authenticate before doing anything else ---------------------------------
    try:
        user, foundry_token, speech_token, client_session_id = await _authenticate(ws)
    except AuthError as ex:
        log.info("auth rejected: %s (%s)", ex.message, ex.code)
        try:
            await ws.send_json({"type": "auth_error", "code": ex.code, "message": ex.message})
        except Exception:
            pass
        # 1008 = policy violation.
        try:
            await ws.close(code=1008)
        except Exception:
            pass
        return

    # ---- Build the session (per-user Foundry client, per-user speech token) ------
    # session_id now comes from the caller (BFF -> frontend-generated uuid) so the same
    # id is used end-to-end. Only falls back to generating one here if the caller
    # didn't supply X-Session-Id / session_id (e.g. an old or ad-hoc test client).
    session_id = client_session_id or str(uuid.uuid4())
    if active_sessions.get(session_id) is not None:
        # Defensive: a caller-supplied session_id must be unique among live
        # connections. Reject rather than silently clobbering an in-flight session.
        log.warning("rejecting duplicate session_id: %s", session_id)
        try:
            await ws.send_json({
                "type": "auth_error", "code": "duplicate_session_id",
                "message": "a session with this session_id is already active",
            })
            await ws.close(code=1008)
        except Exception:
            pass
        return
    try:
        session = ChatSession(session_id, ws, user, foundry_token, speech_token)
    except Exception:
        log.exception("[%s] failed to initialise session", session_id)
        try:
            await ws.send_json({"type": "error", "message": "failed to initialise session"})
            await ws.close(code=1011)
        except Exception:
            pass
        return

    active_sessions[session_id] = session
    log.info("[%s] session created for %s (%s)", session_id, user.upn, user.oid)

    try:
        await session.run()
    finally:
        active_sessions.pop(session_id, None)
