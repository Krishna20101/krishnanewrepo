"""
===============================================================================
 🩺 HEALTH SERVER — bot ko "Web Service" ki tarah host karne ke liye
-------------------------------------------------------------------------------
 Render / Railway / Fly ka FREE tier "Background Worker" nahi deta — wo sirf
 Web Service dete hain, jiske liye process ko ek HTTP PORT bind karna zaroori
 hota hai (warna deploy fail: "Could not bind port").

 Ye module ek mamooli stdlib HTTP server chalata hai (koi nayi dependency
 nahi, asyncio loop se alag daemon thread me):

     GET /healthz , /health   → hamesha 200  (process zinda hai)
     GET /ready               → 200 jab bot Telegram se connected hai, warna 503
     GET /status , /          → poori status JSON (uptime, backend, config…)

 Render dashboard me **Health Check Path = /healthz** bharein, aur free tier
 ko sone se bachane ke liye koi external pinger (UptimeRobot / cron-job.org)
 bhi isi path par 5-10 minute me ek baar hit kara dein.

 ⚠️ Security: yahan kabhi bhi token / session / secret print nahi hota —
    sirf non-sensitive status. Chaaho to BOT_HEALTH_TOKEN set karke status
    ko protect kar sakte ho (tab ?token=… ya X-Bot-Token header chahiye).
===============================================================================
"""

from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, Optional, Tuple

#: Health server kitne second baad request na aane par socket timeout kare
REQUEST_TIMEOUT_SEC = 20

#: bot.py is dict ko update karta rehta hai; health server isi ko serve karta hai
RUNTIME_STATUS: Dict[str, Any] = {
    "state": "starting",  # starting | running | retrying | stopped | fatal
    "attempt": 0,
    "error": "",
    "startedAt": int(time.time() * 1000),
}

StatusProvider = Callable[[], Dict[str, Any]]

_ALWAYS_PUBLIC = ("/healthz", "/health", "/ready")


def _safe_status(provider: Optional[StatusProvider]) -> Dict[str, Any]:
    """Status dict banao — provider crash ho to bhi health endpoint zinda rahe."""
    snap: Dict[str, Any] = dict(RUNTIME_STATUS)
    started_ms = float(snap.get("startedAt") or 0) or time.time() * 1000.0
    snap["uptimeSec"] = max(0, int(time.time() - started_ms / 1000.0))
    if provider is None:
        return snap
    try:
        extra = provider() or {}
        if isinstance(extra, dict):
            snap.update(extra)
    except Exception as exc:  # noqa: BLE001
        snap["statusError"] = "%s: %s" % (type(exc).__name__, exc)
    return snap


def _make_handler(provider: Optional[StatusProvider], token: str) -> type:
    class HealthHandler(BaseHTTPRequestHandler):
        server_version = "shd-bot-health/1"
        protocol_version = "HTTP/1.1"

        # Render ke logs me har ping ka line na aaye
        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401
            return

        def _authorized(self, path: str) -> bool:
            if not token or path in _ALWAYS_PUBLIC:
                return True
            supplied = self.headers.get("X-Bot-Token") or ""
            if not supplied:
                # ?token=… bhi chalega (browser se check karna aasan ho)
                query = path.split("?", 1)[1] if "?" in path else ""
                for part in query.split("&"):
                    if part.startswith("token="):
                        supplied = part[6:]
            return supplied == token

        def _respond(self, code: int, payload: Dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Robots-Tag", "noindex")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _handle(self) -> None:
            raw_path = str(self.path or "/")
            path = raw_path.split("?", 1)[0].rstrip("/") or "/"

            if path in ("/healthz", "/health"):
                # Process zinda hai = 200 (Telegram reconnect ho raha ho tab bhi,
                # warna Render service ko unhealthy maan kar restart kar deta hai)
                snap = _safe_status(provider)
                self._respond(200, {"ok": True, "service": "shd-telegram-bot", **snap})
                return

            if path == "/ready":
                snap = _safe_status(provider)
                ready = str(snap.get("state")) == "running"
                self._respond(
                    200 if ready else 503,
                    {"ok": ready, "state": snap.get("state"), "error": snap.get("error") or ""},
                )
                return

            if path in ("/", "/status", "/statusz"):
                if not self._authorized(raw_path):
                    self._respond(403, {"ok": False, "error": "Invalid or missing bot token."})
                    return
                self._respond(200, {"ok": True, **_safe_status(provider)})
                return

            self._respond(404, {"ok": False, "error": "Not found. Try /healthz"})

        def do_GET(self) -> None:  # noqa: N802
            try:
                self._handle()
            except Exception:  # noqa: BLE001
                pass

        def do_HEAD(self) -> None:  # noqa: N802
            try:
                self._handle()
            except Exception:  # noqa: BLE001
                pass

    return HealthHandler


def health_port_from_env() -> Optional[int]:
    """Kaunsa port bind karna hai.

    • Render/Railway/Fly apna `PORT` dete hain → wahi use hota hai.
    • `BOT_HEALTH_PORT` se override (VPS par apni marzi ka port).
    • `BOT_DISABLE_HEALTH=1` ya `BOT_HEALTH_PORT=0` → server hi nahi chalega
      (local/VPS par jaise pehle chalata tha waise hi).
    • Dono unset → None (local run par koi port nahi khulega).
    """
    if str(os.environ.get("BOT_DISABLE_HEALTH") or "").strip() in ("1", "true", "yes"):
        return None
    override = str(os.environ.get("BOT_HEALTH_PORT") or "").strip()
    if override:
        try:
            value = int(override)
            return None if value <= 0 else value
        except ValueError:
            return None
    render_port = str(os.environ.get("PORT") or "").strip()
    if render_port:
        try:
            value = int(render_port)
            return None if value <= 0 else value
        except ValueError:
            return None
    return None


def start_health_server(
    port: Optional[int] = None,
    provider: Optional[StatusProvider] = None,
) -> Tuple[Optional[ThreadingHTTPServer], Optional[threading.Thread], int]:
    """Daemon thread me health server chalu karo.

    Returns (server, thread, actual_port). Port bind na ho paye to (None, None, 0)
    — bot phir bhi chalta rahega (health server optional hai, crash nahi karta).
    """
    explicit = port is not None
    want = int(port) if explicit else health_port_from_env()
    if want is None or want < 0:
        return None, None, 0
    # env se aaya 0/invalid matlab "server hi mat chalao" (VPS/local default);
    # explicitly 0 bheja ho to OS se koi free (ephemeral) port le lo — tests me use hota hai.
    if want == 0 and not explicit:
        return None, None, 0

    token = str(os.environ.get("BOT_HEALTH_TOKEN") or "").strip()
    try:
        server = ThreadingHTTPServer(("0.0.0.0", int(want)), _make_handler(provider, token))
    except OSError as exc:
        # Port busy / permission denied → chupchap doosra random port lene se
        # Render confuse ho jata hai, isliye server skip; bot chalta rahega.
        print("[healthz] ⚠️ port %s bind nahi hua: %s" % (want, exc))
        return None, None, 0
    server.daemon_threads = True
    actual = int(server.server_address[1])
    thread = threading.Thread(target=server.serve_forever, name="healthz", daemon=True)
    thread.start()
    return server, thread, actual


def stop_health_server(server: Optional[ThreadingHTTPServer]) -> None:
    if server is None:
        return
    try:
        server.shutdown()
        server.server_close()
    except Exception:  # noqa: BLE001
        pass


def set_status(**fields: Any) -> None:
    """bot.py ke liye chhota helper — RUNTIME_STATUS update karo."""
    RUNTIME_STATUS.update(fields)
