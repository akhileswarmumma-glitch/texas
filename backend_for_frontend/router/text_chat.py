

import json
import os

from fastapi import APIRouter,Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
import httpx

from models.auth_models import ConversationResponse
from models.chat_model import ChatRequest
from router.auth import get_current_session
from utils.utils import create_session

router = APIRouter(tags=["Chat"])
BACKEND_URL_TEXT = os.environ.get("BACKEND_URL_TEXT", "http://localhost:8001")


@router.get("/get_conversation_id")
async def create_conversation(session: dict = Depends(get_current_session)):
    try:
        if session:
            conversation_id = create_session()
            return ConversationResponse(message="Success", conversation_id=conversation_id)
        else:
            raise HTTPException(
                status_code=401,
                detail=f"Auth failed"
            )
    except Exception as error:
        raise HTTPException(
            status_code=401,
            detail=f"Authencation failed: {error}"
        )




@router.post("/chat")
async def proxy_chat(request: ChatRequest, session: dict = Depends(get_current_session)):
    try:
        if session:
            backend_token = session.sso_token["user_token"]

            foundry_token = session.sso_token["foundry_token"]
        else:
            backend_token = ""
            foundry_token = ""

        body = request.model_dump()
        print("foundary token is ==>",foundry_token)
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{BACKEND_URL_TEXT}/chat",
                headers={
                    "Authorization": f"Bearer {backend_token}",
                    "X-Foundry-Token": foundry_token
                },
                json=body,
                timeout=60.0
            )
            
        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text)
        return response.json()
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Unexpected error occured : {error}"
        )


@router.post("/chatV1")
async def proxy_chat_v1(
    request: Request,
    body: ChatRequest,
    session: dict = Depends(get_current_session),
):
    if session:
        backend_token = session.sso_token["user_token"]
        foundry_token = session.sso_token["foundry_token"]
    else:
        backend_token = ""
        foundry_token = ""

    print("foundary token is ==>", foundry_token)

    async def event_stream():
        client = httpx.AsyncClient(timeout=None)
        try:
            async with client.stream(
                "POST",
                f"{BACKEND_URL_TEXT}/chatV1",
                headers={
                    "Authorization": f"Bearer {backend_token}",
                    "X-Foundry-Token": foundry_token,
                },
                json=body.model_dump(),
            ) as response:

                if response.status_code != 200:
                    err_body = await response.aread()
                    yield f'data: {{"type": "error", "error": "Backend error {response.status_code}: {err_body.decode(errors="ignore")}"}}\n\n'.encode()
                    return

                async for chunk in response.aiter_raw():
                    if await request.is_disconnected():
                        break
                    if chunk:
                        yield chunk

        except Exception as error:
            err_msg = f"Unexpected error occured : {error}"
            yield f'data: {{"type": "error", "error": {json.dumps(err_msg)}}}\n\n'.encode()

        finally:
            await client.aclose()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
