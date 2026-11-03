"""
utils/nr_logger.py
------------------
Reusable dual-sink logger for the BFF service.

CHANGED (latency fix): console echo used to call print(..., flush=True)
INLINE inside .log(), synchronously, blocking the event loop for its
duration and stalling OTHER concurrent sessions on the same worker
(e.g. voice audio relay frames). Fix: the actual print()+flush is now
dispatched to a single dedicated background thread via
loop.run_in_executor(...), never awaited -- .log() schedules the write and
returns immediately.
"""
import os
import sys
import time
import json
import socket
import asyncio
import logging
import concurrent.futures
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from contextvars import ContextVar

from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
import httpx

_log = logging.getLogger("nr_logger")

traffic_source_ctx: ContextVar[Optional[str]] = ContextVar(
    "nr_traffic_source", default=None
)

KEY_VAULT_NAME = os.environ.get("KEY_VAULT")
KV_URI = f"https://{KEY_VAULT_NAME}.vault.azure.net"
credential = DefaultAzureCredential()
client = SecretClient(vault_url=KV_URI, credential=credential)

_HOSTNAME = socket.gethostname()


class NewRelicLogger:
    def __init__(
        self,
        license_key: str,
        url: str,
        logtype: str,
        service_name: str,
        flush_interval: float = 2.0,
        max_batch: int = 100,
        max_queue: int = 10000,
        console_echo: bool = True,
    ):
        self.license_key = license_key
        self.url = url
        self.logtype = logtype
        self.service_name = service_name
        self.flush_interval = flush_interval
        self.max_batch = max_batch
        self.max_queue = max_queue
        self.console_echo = console_echo

        self._nr_enabled = bool(license_key and url)
        if not self._nr_enabled:
            _log.warning(
                "NewRelicLogger: license_key/url not set — "
                "running in CONSOLE-ONLY mode (no New Relic shipping)."
            )

        self._queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=max_queue)
        self._task: Optional[asyncio.Task] = None
        self._client: Optional[httpx.AsyncClient] = None
        self._closing = False

        self._console_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="nr-console-writer"
        )

    def start(self) -> None:
        if not self._nr_enabled:
            return
        if self._task is None:
            self._client = httpx.AsyncClient(timeout=10.0)
            self._task = asyncio.create_task(self._run(), name="nr-log-flusher")
            _log.info(
                "NewRelicLogger started (logtype=%s, service=%s, console_echo=%s)",
                self.logtype, self.service_name, self.console_echo,
            )

    async def aclose(self) -> None:
        self._closing = True
        if self._task:
            await self._task
            self._task = None
        if self._client:
            await self._client.aclose()
            self._client = None
        self._console_executor.shutdown(wait=True)

    def log(self, record: Dict[str, Any]) -> None:
        now = time.time()
        enriched = {
            "timestamp": int(now * 1000),
            "timestamp_iso": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
            "service.name": self.service_name,
            "host": _HOSTNAME,
            "logtype": record.get("logtype", self.logtype),
            "message": record.get("message", record.get("event", "bff_log")),
            **record,
        }

        src = traffic_source_ctx.get()
        if src:
            enriched.setdefault("traffic_source", src)

        if self.console_echo:
            self._emit_console_nonblocking(enriched)

        if self._nr_enabled:
            try:
                self._queue.put_nowait(enriched)
            except asyncio.QueueFull:
                _log.warning(
                    "NewRelic log queue full (%d); dropping record", self.max_queue
                )

    def _emit_console_nonblocking(self, record: Dict[str, Any]) -> None:
        try:
            loop = asyncio.get_running_loop()
            loop.run_in_executor(self._console_executor, self._emit_console, record)
        except RuntimeError:
            self._emit_console(record)

    @staticmethod
    def _emit_console(record: Dict[str, Any]) -> None:
        try:
            line = json.dumps(record, default=str, ensure_ascii=False)
        except Exception:
            line = json.dumps({"event": "bff_log_serialize_error"})
        print(line, file=sys.stdout, flush=True)

    async def _run(self) -> None:
        batch: list[Dict[str, Any]] = []
        last_flush = time.monotonic()
        while True:
            timeout = self.flush_interval
            try:
                item = await asyncio.wait_for(self._queue.get(), timeout=timeout)
                batch.append(item)
            except asyncio.TimeoutError:
                pass
            now = time.monotonic()
            should_flush = (
                len(batch) >= self.max_batch
                or (batch and now - last_flush >= self.flush_interval)
                or (self._closing and batch)
            )
            if should_flush:
                await self._ship(batch)
                batch = []
                last_flush = now
            if self._closing and self._queue.empty() and not batch:
                break

    async def _ship(self, batch: list[Dict[str, Any]]) -> None:
        if not batch or self._client is None:
            return
        payload = [{"common": {"attributes": {"logtype": self.logtype}}, "logs": batch}]
        headers = {
            "Content-Type": "application/json",
            "Api-Key": self.license_key,
        }
        try:
            resp = await self._client.post(
                self.url, headers=headers, content=json.dumps(payload, default=str)
            )
            if resp.status_code >= 300:
                _log.warning(
                    "NewRelic ingest failed %s: %s", resp.status_code, resp.text[:500]
                )
        except Exception as exc:
            _log.warning("NewRelic ingest exception: %s", exc)


def build_logger() -> NewRelicLogger:
    return NewRelicLogger(
        license_key=client.get_secret(os.getenv("NEW_RELIC_LICENSE_KEY")).value,
        url=os.getenv("NEW_RELIC_LOG_URL", ""),
        logtype=os.getenv("NEW_RELIC_LOGTYPE", ""),
        service_name=os.getenv("NEW_RELIC_SERVICE_NAME", ""),
        flush_interval=float(os.getenv("NEW_RELIC_FLUSH_INTERVAL", "2.0")),
        max_batch=int(os.getenv("NEW_RELIC_MAX_BATCH", "100")),
        max_queue=int(os.getenv("NEW_RELIC_MAX_QUEUE", "10000")),
        console_echo=os.getenv("NEW_RELIC_CONSOLE_ECHO", "true").lower(),
    )
