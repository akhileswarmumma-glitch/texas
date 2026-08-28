"""
BFF (Backend-For-Frontend) Auth & Proxy Service
Run: uvicorn bff:app --reload --port 8000
"""

import os
import uuid
import msal
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from fastapi import APIRouter, Request, HTTPException, Cookie, Depends, Response
from fastapi.responses import JSONResponse, RedirectResponse
from azure.cosmos import CosmosClient
from datetime import datetime, timedelta, timezone
from models.auth_models import DeleteResponse, SSOToken, SuccessResponse, UserData, UserDetailResponse
from utils.utils import decode_jwt_token


router = APIRouter(tags=["Auth"])
KEY_VAULT_NAME = os.environ.get("KEY_VAULT")
KV_URI = f"https://{KEY_VAULT_NAME}.vault.azure.net"

credential = DefaultAzureCredential()
client = SecretClient(vault_url=KV_URI, credential=credential)

CLIENT_ID = client.get_secret(os.environ.get("AAD_CLIENT_ID")).value
CLIENT_SECRET = client.get_secret(os.environ.get("AAD_CLIENT_SECRET")).value
TENANT_ID = client.get_secret(os.environ.get("AAD_TENANT_ID")).value


AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
REDIRECT_URI = os.environ.get("AAD_REDIRECT_URI", "http://localhost:8000/auth/callback")
FOUNDRY_SCOPES = ["https://ai.azure.com/.default"]
BACKEND_SCOPES = os.environ.get("BACKEND_SCOPES", "api://your-backend-scope/.default").split()
POST_LOGIN_REDIRECT = os.environ.get("POST_LOGIN_REDIRECT", "http://localhost:3000/")
LOGIN_SCOPES = [f"api://txrh-RoadieRangerDev-6279-StoSup-pHmO-relay-{CLIENT_ID}/access_as_user"]
COSMOS_ENDPOINT =os.environ.get("COSMOS_ENDPOINT")

cosmos_client = CosmosClient(
    COSMOS_ENDPOINT,
    credential=credential
)
# ============================================================
# PASSTHROUGH APP CONFIGURATION
# ============================================================

PASSTHROUGH_CLIENT_ID = client.get_secret(
    "txrh-RoadieRangerDev-6279-StoSup-pHmO-passthrough-client-id"
).value

PASSTHROUGH_CLIENT_SECRET = client.get_secret(
    "txrh-RoadieRangerDev-6279-StoSup-pHmO-passthrough-client-secret"
).value

PASSTHROUGH_TENANT_ID = client.get_secret(
    "txrh-RoadieRangerDev-6279-StoSup-pHmO-passthrough-tenant-id"
).value

SNOW_CLIENT_ID = client.get_secret(
    "txrh-RoadieRangerDev-6279-StoSup-pHmO-snow-mcp-client-id"
).value

SNOW_CLIENT_SECRET = client.get_secret(
    "txrh-RoadieRangerDev-6279-StoSup-pHmO-snow-mcp-client-secret" 
).value

SNOW_TENANT_ID = client.get_secret(
    "txrh-RoadieRangerDev-6279-StoSup-pHmO-snow-mcp-tenant-id"
).value

TRUST_APP_CLIENT_ID = client.get_secret(
    "txrh-RoadieRangerDev-6279-StoSup-pHmO-trust-client-id"
).value



print(f"PASSTHROUGH_TENANT_ID:{PASSTHROUGH_TENANT_ID}")
print(f"PASSTHROUGH_CLIENT_ID:{PASSTHROUGH_CLIENT_ID}")
print(f"SNOW_CLIENT_ID:{SNOW_CLIENT_ID}")
print(f"SNOW_TENANT_ID:{SNOW_TENANT_ID}")
print(f"TRUST_APP_CLIENT_ID:{TRUST_APP_CLIENT_ID}")
print(f"Relay CLIENT_ID:{CLIENT_ID}")
print(f"Relay TENANT_ID:{TENANT_ID}")


PASSTHROUGH_AUTHORITY = (
    f"https://login.microsoftonline.com/{PASSTHROUGH_TENANT_ID}"
)


MCP_SCOPES = [
    "https://cognitiveservices.azure.com/.default"
]

database = cosmos_client.get_database_client(
    "txrh_rg_sessions"
)

container_sessions = database.get_container_client(
    "sessions"
)

container_user = database.get_container_client(
    "sessions_user"
)


pending_logins: dict[str, dict] = {}   # flow_id -> MSAL flow dict


def msal_app() -> msal.ConfidentialClientApplication:
    return msal.ConfidentialClientApplication(
        client_id=CLIENT_ID, client_credential=CLIENT_SECRET, authority=AUTHORITY
    )

def passthrough_msal_app() -> msal.ConfidentialClientApplication:
    return msal.ConfidentialClientApplication(
        client_id=PASSTHROUGH_CLIENT_ID,
        client_credential=PASSTHROUGH_CLIENT_SECRET,
        authority=PASSTHROUGH_AUTHORITY
    )

def get_mcp_token_from_relay_token(
    relay_token: str
):
    try:

        if not relay_token:
            raise HTTPException(
                status_code=401,
                detail="Relay token is missing."
            )

        # Debug the incoming Relay token
        relay_claims = decode_jwt_token(relay_token)

        print(
            f"Relay Token Audience: "
            f"{relay_claims.get('aud')}"
        )

        print(
            f"Relay Token Scope: "
            f"{relay_claims.get('scp')}"
        )

        print(
            f"Relay Token OID: "
            f"{relay_claims.get('oid')}"
        )

        # ----------------------------------------------------
        # EXACT FLOW YOU REQUESTED:
        #
        # Relay access token
        #       |
        #       | user_assertion
        #       v
        # Passthrough App Registration
        #       |
        #       | MCP access_as_user
        #       v
        # Entra ID
        #       |
        #       v
        # MCP access token
        # ----------------------------------------------------

        mcp_result = (
            passthrough_msal_app()
            .acquire_token_on_behalf_of(
                user_assertion=relay_token,
                scopes=MCP_SCOPES
            )
        )

        if "access_token" not in mcp_result:

            print(
                f"MCP OBO Error: "
                f"{mcp_result.get('error')}"
            )

            print(
                f"MCP OBO Error Description: "
                f"{mcp_result.get('error_description')}"
            )

            print(
                f"MCP OBO Correlation ID: "
                f"{mcp_result.get('correlation_id')}"
            )

            raise HTTPException(
                status_code=401,
                detail={
                    "message": (
                        "Unable to generate MCP token "
                        "using Passthrough App."
                    ),
                    "error": mcp_result.get("error"),
                    "error_description": (
                        mcp_result.get(
                            "error_description"
                        )
                    ),
                    "correlation_id": (
                        mcp_result.get(
                            "correlation_id"
                        )
                    ),
                    "relay_token_audience": (
                        relay_claims.get("aud")
                    )
                }
            )

        return mcp_result["access_token"]

    except HTTPException:
        raise

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=(
                "Unexpected error while generating "
                f"MCP token: {error}"
            )
        )


def get_user_oid (session_id: str):
    try:
        session_doc = container_user.read_item(
            item=session_id,
            partition_key=session_id
        )
        
        print("Inside get user_oid")
        print (f"Session Docs")

        user_oid = session_doc["user_oid"] 
        print(f"Session Doc: {user_oid}")
        return user_oid
    
    except Exception:
        return None

def get_session_from_cosmos(
    session_id: str
):
    user_oid = get_user_oid(session_id)
    try:
        session_doc = container_sessions.read_item(
            item=session_id,
            partition_key=user_oid
        )
        
        print("Inside get session")
        
        expires_at = datetime.fromisoformat(session_doc["expires_at"]) 
        buffer_expiry = expires_at - timedelta(minutes=10)
        
        if datetime.now(timezone.utc) >= buffer_expiry:
            raise HTTPException(
                status_code=401,
                detail="Session expired. Please login again."
            )

        current_time = datetime.now(timezone.utc).isoformat()

        container_sessions.patch_item(
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
        print(f"Session Doc: {session_doc}")
        return session_doc

    except Exception:
        return None

@router.get("/login")
def login():
    try:
        flow = msal_app().initiate_auth_code_flow(scopes=LOGIN_SCOPES, redirect_uri=REDIRECT_URI)
        if "auth_uri" not in flow:
            return JSONResponse(status_code=401, content={"error": "Failed to build auth URL"})

        flow_id = str(uuid.uuid4())
        pending_logins[flow_id] = flow

        response = RedirectResponse(flow["auth_uri"])
        response.set_cookie("login_flow_id", flow_id, httponly=True, secure=True, samesite="lax", max_age=3600)
        return response
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"unexpected error while login {error}"
        )


@router.get("/auth/callback")
def auth_callback(request: Request):
    try:
        flow_id = request.cookies.get("login_flow_id")
        flow = pending_logins.pop(flow_id, None) if flow_id else None
        
        if not flow:
            return JSONResponse(status_code=401, content={"error": "No matching login in progress"})

        try:
            result = msal_app().acquire_token_by_auth_code_flow(flow, dict(request.query_params))
            print(f"Results: {result}")
        except ValueError as e:
            return JSONResponse(status_code=401, content={"error": str(e)})

        if "error" in result:
            return JSONResponse(status_code=401, content={"error": result.get("error_description")})

        user_token = result["access_token"]
        claims = decode_jwt_token(user_token)
        user_oid = claims["oid"]
        upn = claims.get("preferred_username")

        foundry_result = msal_app().acquire_token_on_behalf_of(user_assertion=user_token, scopes=FOUNDRY_SCOPES)

        if "error" in foundry_result:
            return JSONResponse(status_code=401, content={"error": foundry_result.get("error_description")})

        session_id = str(uuid.uuid4())
        # token_details = {
        #     "user_token" : user_token,
        #     "foundry_token" : foundry_result.get("access_token")
        # }
        # cache.set(
        #     session_id, token_details, expire=600
        # )
        expiry_time = datetime.now(timezone.utc) + timedelta(minutes=80)
        session_doc = {
            "id": session_id,
            "user_oid": user_oid,
            "username":upn,
            "user_token": user_token,
            "foundry_token": foundry_result.get("access_token"),
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
        container_sessions.create_item(session_doc)
        container_user.create_item(user_doc)

        response = RedirectResponse(POST_LOGIN_REDIRECT)
        response.set_cookie("session_id", session_id, httponly=True, secure=True, samesite="lax", max_age=3600)
        return response

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {error}"
        )


@router.get("/get_token_with_session_id")
def get_current_session(session_id: str = Cookie(None)):
    try:
        if not session_id:
            raise HTTPException(status_code=401, detail="Session invalid or expired.")
        #session_token = cache.get(session_id)
        user_oid = get_user_oid(session_id)
        
        if not user_oid:
            raise HTTPException(status_code=401, detail="Session invalid or expired.")
        session_doc = get_session_from_cosmos(session_id)
        
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

@router.get("/decoded_user_token_details")
async def decode_token_deatils(token: str = Depends(get_current_session)):
    try:
        token_resp =  decode_jwt_token(token.sso_token.get("user_token"))

        return token_resp
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Internal server Error: {error}"
        )

@router.get("/decoded_foundry_token_details")
async def decode_token_deatils(token: str = Depends(get_current_session)):
    try:
        token_resp =  decode_jwt_token(token.sso_token.get("foundry_token"))

        return token_resp
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Internal server Error: {error}"
        )

@router.get("/generate_passthrough_token")
async def generate_passthrough_token(
    token: SSOToken = Depends(get_current_session)
):
    try:

        # Existing Relay token stored in Cosmos
        relay_token = token.sso_token.get(
            "user_token"
        )

        if not relay_token:
            raise HTTPException(
                status_code=401,
                detail=(
                    "Relay token not found "
                    "in session."
                )
            )

        # Generate MCP token using
        # Passthrough App Registration
        mcp_token = get_mcp_token_from_relay_token(
            relay_token
        )

        # Decode only to verify the generated token
        mcp_claims = decode_jwt_token(
            mcp_token
        )

        return {
            "message": (
                "MCP token generated successfully."
            ),
            "mcp_token": mcp_token,
            "mcp_token_details": {
                "aud": mcp_claims.get("aud"),
                "scp": mcp_claims.get("scp"),
                "oid": mcp_claims.get("oid"),
                "tid": mcp_claims.get("tid"),
                "azp": mcp_claims.get("azp"),
                "appid": mcp_claims.get("appid")
            }
        }

    except HTTPException:
        raise

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=(
                "Internal server error: "
                f"{error}"
            )
        )

@router.post("/auth/me")
async def verify_auth(session_id: str = Cookie(None)):
    if not session_id:
        raise HTTPException(
            status_code=401,
            detail=f"Auth failed as session id not found"
        )
    session_token = get_session_from_cosmos(session_id)
    if not session_token:
        raise HTTPException(
            status_code=401,
            detail=f"Auth failed as token not exist in cosmos"
        )
    return SuccessResponse(message="Success")

@router.get("/get_user_details")
async def get_user_details(token: str = Depends(get_current_session)):
    try:
        token_resp =  decode_jwt_token(token.sso_token.get("user_token"))
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
async def logout(response: Response):
    response.delete_cookie(
        key="session_id",
        path="/"
    )
    return DeleteResponse(message="Success")