import jwt
import secrets
from fastapi import HTTPException


def decode_jwt_token(token: str):
    try:
        decoded_details= jwt.decode(
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