from pathlib import Path
import os
import traceback
import requests
import socket

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from router.auth import router as auth_route
from router.text_chat import router as text_chat_route
from router.cookies import router as cookie_route

app = FastAPI(title="Texas Roadhouse App")
app.include_router(auth_route)
app.include_router(text_chat_route, prefix="/api")
app.include_router(cookie_route)
# ==================================================
# CORS
# ==================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==================================================
# BASIC API ENDPOINTS
# ==================================================

@app.get("/healthz")
async def healthz():
    return {"status": "ok"}

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
        name="assets"
    )



# ==================================================
# SPA FALLBACK
# IMPORTANT: KEEP THIS LAST
# ==================================================

@app.get("/{full_path:path}", include_in_schema=False)
async def serve_spa(request: Request, full_path: str):

    if not FRONTEND_DIST.exists():

        return JSONResponse(
            status_code=503,
            content={
                "error": "Frontend build missing",
                "message": "Run `npm run build` inside 'web_app/' first.",
            },
        )

    raw_path = request.url.path

    if (
        raw_path.startswith("/api/")
        or raw_path.startswith("/healthz")
    ):
        raise HTTPException(
            status_code=404,
            detail="API route not found"
        )

    candidate = FRONTEND_DIST / full_path.lstrip("/")

    if candidate.is_file():
        return FileResponse(str(candidate))

    index_html = FRONTEND_DIST / "index.html"

    if index_html.is_file():
        return FileResponse(str(index_html))

    raise HTTPException(
        status_code=503,
        detail="index.html not found in build output"
    )