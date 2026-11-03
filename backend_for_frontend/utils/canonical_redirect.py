"""
Canonical host redirect middleware.

Purpose:
    Exactly 3 known hosts are registered / CNAME-mapped for this app:
        - roadieranger-dev.txrh.com      (CANONICAL -- never redirected)
        - rr-dev.txrh.com                (redirected -> canonical)
        - <app>.azurewebsites.net        (redirected -> canonical)

    Whichever of the 3 a user hits, they get redirected to the ONE
    canonical host first -- before the landing page, /login, or anything
    else executes. Login/auth then always happens on that single
    canonical host.

    IMPORTANT: only these 3 known hosts trigger a redirect. Any other
    Host header (spoofed, unknown, a random domain someone points DNS at,
    etc.) is explicitly NOT redirected -- see UNKNOWN_HOST_BEHAVIOR below.
    This is a deliberate allow-list, not "redirect anything that isn't
    canonical".

Usage (in main.py, where the FastAPI app is created):

    from canonical_redirect import CanonicalHostRedirectMiddleware
    app.add_middleware(CanonicalHostRedirectMiddleware)

Env vars:
    CANONICAL_HOST      e.g. "roadieranger-dev.txrh.com"   (required)
                        The one host everything gets redirected TO.
                        Never redirected away from itself.

    CANONICAL_SCHEME    default "https"

    KNOWN_REDIRECT_HOSTS
                        comma-separated ALLOW-LIST of the *other* hosts
                        that SHOULD be redirected to CANONICAL_HOST.
                        Only requests whose Host header exactly matches
                        one of these (or CANONICAL_HOST itself) are
                        recognized at all.
                        default:
                          "rr-dev.txrh.com,
                           txrh-app-roadierangerdev-6279-stosup-phmo.azurewebsites.net"

    CANONICAL_REDIRECT_EXEMPT_PATHS
                        comma-separated list of paths that should NEVER be
                        redirected even on a known non-canonical host --
                        e.g. platform/App Service health probes that get
                        curled directly against a specific host and must
                        respond 200 from that host itself.
                        Supports a trailing "*" wildcard, e.g. "/health*".
                        default: "/health,/healthz"

    UNKNOWN_HOST_BEHAVIOR
                        What to do if the Host header is something OTHER
                        than CANONICAL_HOST or one of KNOWN_REDIRECT_HOSTS
                        (e.g. a spoofed/garbage Host header). Options:
                          "pass"  (default) -- ignore, just process request
                                   normally (safe: Azure only routes traffic
                                   for hostnames actually bound to this app,
                                   so this mainly guards against a raw IP
                                   hit or forged Host header on an app that
                                   accepts default hostnames).
                          "reject" -- return HTTP 400 immediately.
                        We never redirect to anything other than
                        CANONICAL_HOST, so this setting is not an open-
                        redirect risk either way -- it only controls
                        whether unrecognized hosts are served or blocked.

This is a REDIRECT (HTTP 307), not a rewrite/reverse-proxy: the browser's
address bar changes to CANONICAL_HOST and it issues a brand new request.
That's intentional -- it's what keeps cookies (login_flow_id, session_id)
and the AAD redirect_uri all consistently scoped to the one canonical host.
A rewrite (keeping the original URL in the address bar while serving
content from elsewhere) is a different mechanism entirely and would need
to live at the edge/network layer (Azure Front Door / Application Gateway
in front of all 3 domains) -- not something this app-level middleware does,
and not needed for canonicalizing to one login/auth host.
"""

import os
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import RedirectResponse, PlainTextResponse

CANONICAL_HOST = os.environ.get("CANONICAL_HOST", "").lower()
CANONICAL_SCHEME = os.environ.get("CANONICAL_SCHEME", "https")

_known_hosts_raw = os.environ.get(
    "KNOWN_REDIRECT_HOSTS",
    "",
)
KNOWN_REDIRECT_HOSTS = {
    h.strip().lower() for h in _known_hosts_raw.split(",") if h.strip()
}

# Full allow-list = canonical host + the other known hosts that redirect to it.
ALL_KNOWN_HOSTS = KNOWN_REDIRECT_HOSTS | {CANONICAL_HOST}

_exempt_raw = os.environ.get("CANONICAL_REDIRECT_EXEMPT_PATHS", "/health,/healthz")
CANONICAL_REDIRECT_EXEMPT_PATHS = {
    p.strip() for p in _exempt_raw.split(",") if p.strip()
}

UNKNOWN_HOST_BEHAVIOR = os.environ.get("UNKNOWN_HOST_BEHAVIOR", "pass").strip().lower()


def _is_exempt(path: str) -> bool:
    for pattern in CANONICAL_REDIRECT_EXEMPT_PATHS:
        if pattern.endswith("*"):
            if path.startswith(pattern[:-1]):
                return True
        elif path == pattern:
            return True
    return False


class CanonicalHostRedirectMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Honor reverse-proxy / App Gateway / Front Door forwarded headers
        # if present, otherwise fall back to the Host header directly.
        raw_host = (
            request.headers.get("x-forwarded-host")
            or request.headers.get("host")
            or request.url.hostname
            or ""
        )
        incoming_host = raw_host.split(",")[0].strip().split(":")[0].lower()
        path = request.url.path

        # Host not one of our 3 known hosts at all -> not our concern to
        # redirect. Handle per UNKNOWN_HOST_BEHAVIOR.
        if incoming_host not in ALL_KNOWN_HOSTS:
            if UNKNOWN_HOST_BEHAVIOR == "reject":
                return PlainTextResponse("Unrecognized host.", status_code=400)
            return await call_next(request)

        if (
            incoming_host in KNOWN_REDIRECT_HOSTS
            and incoming_host != CANONICAL_HOST
            and not _is_exempt(path)
        ):
            target = f"{CANONICAL_SCHEME}://{CANONICAL_HOST}{request.url.path}"
            if request.url.query:
                target += f"?{request.url.query}"

            # 307 preserves the original HTTP method (safer than 301/302 for
            # anything that isn't a plain GET, and avoids browsers permanently
            # caching the redirect target in case CANONICAL_HOST ever changes).
            return RedirectResponse(url=target, status_code=307)

        return await call_next(request)
