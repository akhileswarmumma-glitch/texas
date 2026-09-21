from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel

from utils.utils import get_logger

router = APIRouter(tags=["Cookies"])


class CookieRequest(BaseModel):
    key: str
    value: str


@router.post("/set-cookie")
async def set_cookie(
    data: CookieRequest,
    response: Response,
    logger=Depends(get_logger),
):
    response.set_cookie(
        key=data.key,
        value=data.value,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/"
    )
    # Never log the cookie value — only that a cookie was set.
    logger.log({
        "event": "bff_cookie_set",
        "cookie_key": data.key,
    })
    return {
        "message": "Cookie set successfully"
    }
