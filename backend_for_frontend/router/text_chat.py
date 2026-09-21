import json
import os
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
import httpx
from models.auth_models import ConversationResponse
from models.chat_model import ChatRequest
from backend_for_frontend.router.auth import get_current_session
from utils.utils import create_session, get_logger, get_http_client, user_from_session

router = APIRouter(tags=["Chat"])

BACKEND_URL_TEXT = os.environ.get("BACKEND_URL_TEXT", "http://localhost:8001")


def _rid(request: Request):
    return getattr(request.state, "request_id", None)


@router.get("/get_conversation_id")
async def create_conversation(
    request: Request,
    session: dict = Depends(get_current_session),
    logger=Depends(get_logger),
):
    if not session:
        raise HTTPException(status_code=401, detail="Auth failed: no valid session")
    conversation_id = create_session()
    logger.log({
        "event": "bff_conversation_created",
        "request_id": _rid(request),
        "conversation_id": conversation_id,
        **user_from_session(session),
    })
    return ConversationResponse(message="Success", conversation_id=conversation_id)


@router.post("/chat")
async def proxy_chat(
    request: Request,
    body: ChatRequest,
    session: dict = Depends(get_current_session),
    logger=Depends(get_logger),
    http_client: httpx.AsyncClient = Depends(get_http_client),
):
    user_info = user_from_session(session)
    rid = _rid(request)
    if not session:
        raise HTTPException(status_code=401, detail="Auth failed: no valid session")
    backend_token = session.sso_token["user_token"]
    foundry_token = session.sso_token["foundry_token"]
    payload = body.model_dump()

    try:
        response = await http_client.post(
            f"{BACKEND_URL_TEXT}/chat",
            headers={
                "Authorization": f"Bearer {backend_token}",
                "X-Foundry-Token": foundry_token,
            },
            json=payload,
            timeout=60.0,
        )
    except httpx.RequestError as net_err:
        logger.log({
            "event": "bff_chat_error",
            "request_id": rid,
            "conversation_id": payload.get("conversation_id"),
            "error": f"{type(net_err).__name__}: {net_err}",
            "error_category": "bff_proxy_error",
            "display_message": "The BFF could not reach the chat backend.",
            "backend_url": BACKEND_URL_TEXT,
            **user_info,
        })
        raise HTTPException(status_code=502, detail=f"BFF could not reach backend: {net_err}")

    if response.status_code != 200:
        backend_body = response.text
        backend_detail = backend_body
        try:
            parsed = response.json()
            backend_detail = parsed.get("error") or parsed.get("detail") or backend_body
        except Exception:
            parsed = None
        logger.log({
            "event": "bff_chat_error",
            "request_id": rid,
            "conversation_id": payload.get("conversation_id"),
            "status": response.status_code,
            "error": str(backend_detail)[:2000],
            "backend_body": backend_body[:2000],
            "error_category": "backend_error",
            "display_message": "The chat backend returned an error.",
            **user_info,
        })
        raise HTTPException(status_code=response.status_code, detail=backend_detail)

    logger.log({
        "event": "bff_chat_request",
        "request_id": rid,
        "conversation_id": payload.get("conversation_id"),
        "status": 200,
        **user_info,
    })
    return response.json()


@router.post("/chatV1")
async def proxy_chat_v1(
    request: Request,
    body: ChatRequest,
    session: dict = Depends(get_current_session),
    logger=Depends(get_logger),
    http_client: httpx.AsyncClient = Depends(get_http_client),
):
    user_info = user_from_session(session)
    rid = _rid(request)
    if not session:
        raise HTTPException(status_code=401, detail="Auth failed: no valid session")
    backend_token = session.sso_token["user_token"]
    foundry_token = session.sso_token["foundry_token"]

    logger.log({
        "event": "bff_chat_stream_started",
        "request_id": rid,
        "conversation_id": body.conversation_id,
        **user_info,
    })

    async def event_stream():
        try:
            async with http_client.stream(
                "POST",
                f"{BACKEND_URL_TEXT}/chat",
                headers={
                    "Authorization": f"Bearer {backend_token}",
                    "X-Foundry-Token": foundry_token,
                },
                json=body.model_dump(),
                timeout=None,
            ) as response:
                if response.status_code != 200:
                    err_body = await response.aread()
                    decoded = err_body.decode(errors="ignore")
                    logger.log({
                        "event": "bff_chat_stream_error",
                        "request_id": rid,
                        "conversation_id": body.conversation_id,
                        "status": response.status_code,
                        "error": decoded[:2000],
                        "error_category": "backend_error",
                        "display_message": "The chat backend returned an error.",
                        **user_info,
                    })
                    yield f'data: {{"type": "error", "status": {response.status_code}, "error": {json.dumps(decoded)}}}\n\n'.encode()
                    return
                async for chunk in response.aiter_raw():
                    if await request.is_disconnected():
                        logger.log({
                            "event": "bff_chat_stream_disconnected",
                            "request_id": rid,
                            "conversation_id": body.conversation_id,
                            **user_info,
                        })
                        break
                    if chunk:
                        yield chunk
        except httpx.RequestError as net_err:
            logger.log({
                "event": "bff_chat_stream_error",
                "request_id": rid,
                "conversation_id": body.conversation_id,
                "error": f"{type(net_err).__name__}: {net_err}",
                "error_category": "bff_proxy_error",
                "display_message": "The BFF could not reach the chat backend.",
                **user_info,
            })
            yield f'data: {{"type": "error", "category": "bff_proxy_error", "error": {json.dumps(str(net_err))}}}\n\n'.encode()
        except Exception as error:
            import traceback as _tb
            logger.log({
                "event": "bff_chat_stream_error",
                "request_id": rid,
                "conversation_id": body.conversation_id,
                "error": f"{type(error).__name__}: {error}",
                "traceback": _tb.format_exc()[:6000],
                "error_category": "bff_server_error",
                "display_message": "An unexpected error occurred while streaming.",
                **user_info,
            })
            yield f'data: {{"type": "error", "category": "bff_server_error", "error": {json.dumps(str(error))}}}\n\n'.encode()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
