from fastapi import APIRouter, Response
from pydantic import BaseModel

router = APIRouter(tags=["Cookies"])


class CookieRequest(BaseModel):
    key: str
    value: str


@router.post("/set-cookie")
async def set_cookie(data: CookieRequest, response: Response):

    response.set_cookie(
        key=data.key,
        value=data.value,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/"
    )

    return {
        "message": "Cookie set successfully"
    }