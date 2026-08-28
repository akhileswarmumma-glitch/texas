from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Texas Roadhouse App")

# Enable CORS for local dev (when Vite dev server runs on 5173)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Declare API Endpoints FIRST
@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/api/example")
async def example():
    return {"message": "Data from FastAPI backend"}


# Locate frontend dist directory relative to main.py
# .parent goes up from main.py to /backend, .parent.parent goes up to root project directory
FRONTEND_DIST = Path(__file__).parent.parent / "texas_roadie_ranger" / "dist"

# Mount bundled assets directory (/assets)
assets_dir = FRONTEND_DIST / "assets"
if assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")


# SPA Fallback Catch-All
@app.get("/{full_path:path}", include_in_schema=False)
async def serve_spa(request: Request, full_path: str):
    if not FRONTEND_DIST.exists():
        return JSONResponse(
            status_code=503,
            content={
                "error": "Frontend build missing",
                "message": "Run `npm run build` inside 'texas_roadie_ranger/' first.",
            },
        )

    # Prevent non-existent API routes from serving index.html
    raw_path = request.url.path
    if raw_path.startswith("/api/") or raw_path.startswith("/healthz"):
        raise HTTPException(status_code=404, detail="API route not found")

    # Serve static root files (favicon.ico, manifest.json, images in public/)
    candidate = FRONTEND_DIST / full_path.lstrip("/")
    if candidate.is_file():
        return FileResponse(str(candidate))

    # Return index.html for client-side routes (e.g. /dashboard)
    index_html = FRONTEND_DIST / "index.html"
    if index_html.is_file():
        return FileResponse(str(index_html))

    raise HTTPException(status_code=503, detail="index.html not found in build output")