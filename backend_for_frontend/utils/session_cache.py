"""
utils/session_cache.py
-----------------------
Local, same-container, multi-worker-safe cache for session documents,
sitting IN FRONT of Cosmos DB reads.

WHY THIS EXISTS
----------------
get_current_session() (router/auth.py) is a shared FastAPI dependency hit on
EVERY authenticated request across BOTH text chat and voice. With multiple
`uvicorn --workers` per container AND multiple KEDA-scaled replicas, that was
previously a Cosmos read_item() x2 (get_user_oid + the session doc itself)
PLUS a patch_item() (to bump last_seen) on EVERY single request.

WHY diskcache SPECIFICALLY (not a plain python dict)
------------------------------------------------------
A plain in-process dict would NOT be visible across `--workers N` (separate
OS processes = separate memory) -- exactly the bug that broke the old
pending_logins dict in router/auth.py (fixed separately -- see
store_login_flow/pop_login_flow, now backed by the dedicated Cosmos
container "login_flows"). diskcache instead backs its cache with a SQLite
file on local disk, and is explicitly documented as thread-safe AND
process-safe: "Two Cache objects may also reference the same directory from
separate threads or processes. In this way, they are also process-safe and
support cross-process communication." That gives every worker process on
the SAME container a real shared cache, with no actual shared RAM and no
extra network hop to something like Redis.

WHAT THIS DOES **NOT** SOLVE (by design)
-------------------------------------------
This cache is LOCAL TO ONE CONTAINER/REPLICA'S DISK. It is NOT shared across
KEDA-scaled replicas -- a newly scaled-out replica starts with an empty
cache and correctly falls back to Cosmos on its first few requests (a cache
miss). That's intentional: Cosmos remains the cross-replica source of truth;
this is purely a same-container read-amplification reducer.

IMPORTANT -- Azure App Service specific gotcha
-------------------------------------------------
On Linux App Service, `/home` is backed by Azure Files -- persistent, NETWORK
storage explicitly documented as shared between all scaled-out instances of
your site. That's the OPPOSITE of what we want here: a SQLite-backed cache
(diskcache) run against a shared network file system is unsupported/
unreliable. CACHE_DIR below defaults to a path under /tmp specifically to
avoid this -- /tmp on both App Service Linux and Azure Container Apps is
local, ephemeral, per-instance disk (NOT persisted, NOT shared). Do not
repoint this at /home.

KNOWN EDGE CASE (documented upstream, harmless here)
-------------------------------------------------------
diskcache's own maintainers acknowledge a narrow race: if many
threads/processes construct `diskcache.Cache(same_path)` for the very first
time (path doesn't exist yet) at almost the exact same instant, SQLite can
raise "database is locked" during that one-time initialization. This is
exactly the scenario `--workers N` creates at container boot (N processes
starting together). _construct_cache_with_retry() below retries with
backoff to survive that narrow window instead of crashing a worker on
startup.
"""
import os
import time
from typing import Optional

import diskcache
from fastapi.concurrency import run_in_threadpool

# Local, ephemeral, per-instance disk -- see module docstring for why NOT /home.
CACHE_DIR = os.environ.get("SESSION_CACHE_DIR", "/tmp/bff_session_cache")

# How long a session doc may be served from the local cache before we go back
# to Cosmos to re-validate + refresh last_seen.
CACHE_TTL_SECONDS = int(os.environ.get("SESSION_CACHE_TTL_SECONDS", "45"))

_cache: Optional[diskcache.Cache] = None


def _construct_cache_with_retry() -> diskcache.Cache:
    """Blocking (disk/SQLite I/O) -- always called off the event loop via
    run_in_threadpool, never inline."""
    last_err = None
    for attempt in range(5):
        try:
            return diskcache.Cache(CACHE_DIR)
        except Exception as e:  # pragma: no cover - narrow, documented upstream race
            last_err = e
            time.sleep(0.15 * (attempt + 1))
    raise last_err


async def init_session_cache() -> None:
    """Call once from main.py's lifespan startup (same pattern as
    init_cosmos()/app.state.http_client)."""
    global _cache
    _cache = await run_in_threadpool(_construct_cache_with_retry)


async def aclose_session_cache() -> None:
    """Call once from main.py's lifespan shutdown (mirrors aclose_cosmos())."""
    global _cache
    if _cache is not None:
        await run_in_threadpool(_cache.close)
        _cache = None


def _key(session_id: str) -> str:
    return f"session:{session_id}"


async def get_cached_session(session_id: str) -> Optional[dict]:
    """Non-blocking (threadpooled) cache lookup. Returns None on a cache
    miss (including if the cache failed to initialize -- callers must treat
    None as 'go to Cosmos', i.e. fail OPEN to the source of truth)."""
    if _cache is None:
        return None
    return await run_in_threadpool(_cache.get, _key(session_id))


async def set_cached_session(session_id: str, session_doc: dict) -> None:
    """Non-blocking (threadpooled) cache write with TTL."""
    if _cache is None:
        return
    await run_in_threadpool(_cache.set, _key(session_id), session_doc, CACHE_TTL_SECONDS)


async def invalidate_cached_session(session_id: str) -> None:
    """Call on logout so a stale cached copy can't be served post-logout."""
    if _cache is None:
        return
    await run_in_threadpool(_cache.delete, _key(session_id))
