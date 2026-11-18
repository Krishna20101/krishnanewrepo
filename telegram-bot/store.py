#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
===============================================================================
 STUDY HELPER DOC — BOT STORAGE LAYER  (store.py)
===============================================================================
 Do backend, ek hi simple API:

   1) FIREBASE RTDB  (default / recommended)
      Website (Vercel) aur bot ek hi database share karte hain — isliye admin
      panel ke "Telegram Bot Delivery" tab me live stats/limit/broadcast sab
      dikhta aur kaam karta hai. Aapke Vercel wale hi env vars chahiye:
        FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
        FIREBASE_DATABASE_URL
      (Firebase Admin SDK rules bypass karta hai — RTDB rules locked hi rahenge.)

   2) SQLITE  (automatic fallback)
      Firebase config na ho / import fail ho to bot phir bhi chalega —
      sab kuch local `bot_state.db` me save hoga (limits, deletions, stats).
      Is mode me website se deep-link request nahi mil payegi, isliye bot ko
      `/find <course> | <title>` command se manually bhi chalaya ja sakta hai.

 Paths (RTDB nodes):
   tg_requests/<shortId>      ← website banata hai (kis video ko bhejna hai)
   bot_state/config           ← limits, auto-delete hours, credit username...
   bot_state/users/<tgUid>    ← per-user quota + total
   bot_state/stats            ← all-time counters
   bot_state/deletions/<id>   ← 2 ghante baad delete hone wale messages
   bot_state/events/<id>      ← recent activity/error log (capped)
   bot_state/tasks/<id>       ← admin panel se aaye broadcast/limit tasks
===============================================================================
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional

# ─────────────────────────────────────────────────────────────────────────────
# DEFAULT BOT CONFIG  (admin panel / bot commands se override hota hai)
# ─────────────────────────────────────────────────────────────────────────────
DEFAULT_CONFIG: Dict[str, Any] = {
    #: Har user 24 ghante me kitne video le sakta hai
    "dailyLimit": 12,
    #: Quota window (hours) — rolling window
    "quotaWindowHours": 24,
    #: Delivered video kitni der baad auto-delete ho
    "autoDeleteHours": 2,
    #: Caption credit — "Extracted By @<creditUsername>"
    "creditUsername": "krishna84",
    #: "clean"  = download + fresh upload (no 'Forwarded from', apna caption) ← DEFAULT
    #: "forward" = seedha forward (fast, par original caption + source dikhta hai)
    "deliveryMode": "clean",
    #: Limit khatam hone par dikhne wala contact handle
    "contactUsername": "krishna84",
    #: Bot khud apna username yahan likh deta hai (website deep-link ke liye)
    "botUsername": "",
    #: Admin Telegram user ids (comma separated string bhi chalega)
    "adminTgIds": "",
    #: Deep-link request kitne ghante valid rahe
    "requestTtlHours": 168,
    #: Search kitne dialogs tak jhuke (bade account ke liye badhayein)
    "maxDialogs": 60,
    "maxMessagesPerChat": 40,
    #: Deep scan (sirf tab jab direct + search dono fail ho)
    "deepScan": True,
    #: Delivery pause (maintenance switch)
    "paused": False,
    "pauseMessage": "Service is paused for maintenance. Please try again later.",
    #: Max file size bot upload karega (Telegram bot limit = 2 GB)
    "maxUploadMb": 2000,

    # ── 🛡️ ANTI-THEFT (v6) — koi scraper poora course na utha le ───────────
    #: Poori site ka 24h circuit breaker (0 = off). Isse zyada video ek din me
    #: deliver hone par bot naye requests mana kar deta hai.
    "globalDailyLimit": 500,
    #: Ek deep-link kitni baar use ho sakta hai (1 = single-use).
    "requestReuseLimit": 1,
    #: Same user + same video cooldown (minutes) — website side reuse karta hai.
    "requestCooldownMin": 5,
    #: Ek user ke kitne PENDING (undelivered) links allow hain.
    "maxPendingPerUser": 3,

    # ── 🔒 CHANNEL JOIN-GATE (v7) — delivery se pehle channel membership ────
    #: True = student ko pehle channel join karna hoga, warna video nahi milegi.
    "joinGateEnabled": False,
    #: Kaunsa channel check karna hai — "@username" ya "-100xxxxxxxxxx".
    #: ⚠️ Bot ko us channel me ADMIN hona chahiye (member list padhne ke liye).
    "joinGateChannel": "",
    #: "Join our channel" button ka link (khaali chhoda to channel username se
    #: apne aap https://t.me/<username> ban jata hai).
    "joinGateInviteUrl": "",
}

STATE_PREFIX = "bot_state"


def _now_ms() -> int:
    return int(time.time() * 1000)


# ─────────────────────────────────────────────────────────────────────────────
# BASE
# ─────────────────────────────────────────────────────────────────────────────
class Store:
    backend = "memory"

    def get(self, path: str) -> Any:  # pragma: no cover - interface
        raise NotImplementedError

    def set(self, path: str, value: Any) -> bool:  # pragma: no cover
        raise NotImplementedError

    def delete(self, path: str) -> bool:  # pragma: no cover
        raise NotImplementedError

    def children(self, path: str) -> Dict[str, Any]:  # pragma: no cover
        raise NotImplementedError

    def close(self) -> None:
        return None

    # ── Generic helpers (dono backend me same behaviour) ───────────────────
    def get_config(self) -> Dict[str, Any]:
        data = self.get("%s/config" % STATE_PREFIX) or {}
        if not isinstance(data, dict):
            data = {}
        merged = dict(DEFAULT_CONFIG)
        for key, value in data.items():
            if value is None:
                continue
            merged[key] = value
        return merged

    def save_config(self, partial: Dict[str, Any]) -> Dict[str, Any]:
        current = self.get_config()
        current.update({k: v for k, v in partial.items() if v is not None})
        current["updatedAt"] = _now_ms()
        self.set("%s/config" % STATE_PREFIX, current)
        return current

    # ── Website deep-link requests ─────────────────────────────────────────
    def get_request(self, short_id: str) -> Optional[Dict[str, Any]]:
        data = self.get("tg_requests/%s" % short_id)
        if not isinstance(data, dict) or not data:
            return None
        ttl_hours = float(self.get_config().get("requestTtlHours") or 168)
        created = float(data.get("createdAt") or 0)
        if created and ttl_hours > 0:
            age_hours = (time.time() - created / 1000.0) / 3600.0
            if age_hours > ttl_hours:
                return None
        return data

    def set_request(self, short_id: str, payload: Dict[str, Any]) -> bool:
        return self.set("tg_requests/%s" % short_id, payload)

    def delete_request(self, short_id: str) -> bool:
        return self.delete("tg_requests/%s" % short_id)

    def list_requests(self) -> Dict[str, Any]:
        return self.children("tg_requests") or {}

    # ── Users + quota ──────────────────────────────────────────────────────
    def get_user(self, tg_uid: int) -> Dict[str, Any]:
        data = self.get("%s/users/%s" % (STATE_PREFIX, tg_uid)) or {}
        if not isinstance(data, dict):
            data = {}
        return data

    def save_user(self, tg_uid: int, data: Dict[str, Any]) -> bool:
        return self.set("%s/users/%s" % (STATE_PREFIX, tg_uid), data)

    def list_users(self) -> Dict[str, Any]:
        return self.children("%s/users" % STATE_PREFIX) or {}

    def quota_status(self, tg_uid: int) -> Dict[str, Any]:
        """Rolling-window quota: {limit, used, remaining, resetInSec, banned}."""
        cfg = self.get_config()
        user = self.get_user(tg_uid)
        limit = int(user.get("limit") if user.get("limit") is not None else cfg.get("dailyLimit") or 12)
        window_ms = int(float(cfg.get("quotaWindowHours") or 24) * 3600 * 1000)
        now = _now_ms()

        stamps: List[int] = [int(x) for x in (user.get("recent") or []) if x]
        fresh = [s for s in stamps if now - s <= window_ms]
        used = len(fresh)
        reset_in = 0
        if fresh and used >= limit:
            reset_in = int((window_ms - (now - min(fresh))) / 1000)
        return {
            "limit": limit,
            "used": used,
            "remaining": max(0, limit - used),
            "resetInSec": max(0, reset_in),
            "banned": bool(user.get("banned")),
            "totalVideos": int(user.get("totalVideos") or 0),
        }

    def consume_quota(self, tg_uid: int) -> Dict[str, Any]:
        """Ek delivery successful → quota + counters update."""
        cfg = self.get_config()
        user = self.get_user(tg_uid)
        window_ms = int(float(cfg.get("quotaWindowHours") or 24) * 3600 * 1000)
        now = _now_ms()
        stamps = [int(x) for x in (user.get("recent") or []) if x]
        stamps = [s for s in stamps if now - s <= window_ms]
        stamps.append(now)
        stamps = stamps[-60:]

        user.update(
            {
                "recent": stamps,
                "totalVideos": int(user.get("totalVideos") or 0) + 1,
                "lastSeen": now,
                "firstSeen": user.get("firstSeen") or now,
            }
        )
        self.save_user(tg_uid, user)

        stats = self.get("%s/stats" % STATE_PREFIX) or {}
        if not isinstance(stats, dict):
            stats = {}
        stats["totalVideosSent"] = int(stats.get("totalVideosSent") or 0) + 1
        stats["lastDeliveryAt"] = now
        self.set("%s/stats" % STATE_PREFIX, stats)
        return self.quota_status(tg_uid)

    def register_user(self, tg_uid: int, info: Dict[str, Any]) -> None:
        user = self.get_user(tg_uid)
        now = _now_ms()
        user.update(
            {
                "id": tg_uid,
                "firstSeen": user.get("firstSeen") or now,
                "lastSeen": now,
                "username": info.get("username") or user.get("username") or "",
                "firstName": info.get("first_name") or user.get("firstName") or "",
                "lastName": info.get("last_name") or user.get("lastName") or "",
            }
        )
        self.save_user(tg_uid, user)

        stats = self.get("%s/stats" % STATE_PREFIX) or {}
        if not isinstance(stats, dict):
            stats = {}
        users = self.list_users()
        stats["totalUsers"] = len(users)
        stats["lastSeenAt"] = now
        self.set("%s/stats" % STATE_PREFIX, stats)

    def stats(self) -> Dict[str, Any]:
        data = self.get("%s/stats" % STATE_PREFIX) or {}
        if not isinstance(data, dict):
            data = {}
        users = self.list_users()
        out = {
            "totalUsers": len(users),
            "totalVideosSent": int(data.get("totalVideosSent") or 0),
            "lastDeliveryAt": int(data.get("lastDeliveryAt") or 0),
            "botUsername": self.get_config().get("botUsername") or "",
            "backend": self.backend,
        }
        # aaj (last 24h) kitne video gaye
        now = _now_ms()
        day = 0
        for u in users.values():
            if isinstance(u, dict):
                day += len([s for s in (u.get("recent") or []) if now - int(s) <= 86400000])
        out["videosLast24h"] = day
        out["pendingDeletions"] = len(self.children("%s/deletions" % STATE_PREFIX) or {})
        return out

    # ── Auto-delete queue (restart-safe) ───────────────────────────────────
    def add_deletion(self, tg_uid: int, message_id: int, delete_at_ms: int) -> bool:
        key = "%s-%s" % (tg_uid, message_id)
        return self.set(
            "%s/deletions/%s" % (STATE_PREFIX, key),
            {
                "uid": int(tg_uid),
                "messageId": int(message_id),
                "deleteAt": int(delete_at_ms),
                "createdAt": _now_ms(),
            },
        )

    def due_deletions(self) -> List[Dict[str, Any]]:
        now = _now_ms()
        out: List[Dict[str, Any]] = []
        for key, val in (self.children("%s/deletions" % STATE_PREFIX) or {}).items():
            if isinstance(val, dict) and int(val.get("deleteAt") or 0) <= now:
                val = dict(val)
                val["_key"] = key
                out.append(val)
        return out

    def remove_deletion(self, key: str) -> bool:
        return self.delete("%s/deletions/%s" % (STATE_PREFIX, key))

    def pending_deletions(self) -> List[Dict[str, Any]]:
        out = []
        for key, val in (self.children("%s/deletions" % STATE_PREFIX) or {}).items():
            if isinstance(val, dict):
                val = dict(val)
                val["_key"] = key
                out.append(val)
        return out

    # ── Event log (capped) ─────────────────────────────────────────────────
    def log_event(self, event_type: str, **fields: Any) -> None:
        key = "%d" % _now_ms()
        payload = {"type": event_type, "at": _now_ms()}
        payload.update(fields)
        self.set("%s/events/%s" % (STATE_PREFIX, key), payload)
        # cap: 400 se zyada events na rakhein
        events = self.children("%s/events" % STATE_PREFIX) or {}
        if len(events) > 400:
            for old in sorted(events.keys())[: len(events) - 400]:
                self.delete("%s/events/%s" % (STATE_PREFIX, old))

    def recent_events(self, limit: int = 15) -> List[Dict[str, Any]]:
        events = self.children("%s/events" % STATE_PREFIX) or {}
        rows = [v for v in events.values() if isinstance(v, dict)]
        rows.sort(key=lambda r: -int(r.get("at") or 0))
        return rows[:limit]

    # ── Admin tasks (website → bot) ────────────────────────────────────────
    def claim_tasks(self) -> List[Dict[str, Any]]:
        out = []
        for key, val in (self.children("%s/tasks" % STATE_PREFIX) or {}).items():
            if isinstance(val, dict) and val.get("status") in (None, "pending"):
                val = dict(val)
                val["_key"] = key
                out.append(val)
        out.sort(key=lambda t: int(t.get("createdAt") or 0))
        return out

    def mark_task(self, key: str, status: str, result: str = "") -> bool:
        return self.set(
            "%s/tasks/%s" % (STATE_PREFIX, key),
            {"status": status, "result": result, "doneAt": _now_ms()},
        )


# ─────────────────────────────────────────────────────────────────────────────
# SQLITE BACKEND (fallback)
# ─────────────────────────────────────────────────────────────────────────────
class SqliteStore(Store):
    backend = "sqlite"

    def __init__(self, path: str = "bot_state.db") -> None:
        self.path = path
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False, timeout=15)
        self._conn.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)")
        self._conn.commit()

    def _norm(self, path: str) -> str:
        return path.strip("/")

    def get(self, path: str) -> Any:
        key = self._norm(path)
        with self._lock:
            row = self._conn.execute("SELECT v FROM kv WHERE k = ?", (key,)).fetchone()
        if row:
            try:
                return json.loads(row[0])
            except Exception:
                return row[0]
        kids = self.children(key)
        return kids if kids else None

    def set(self, path: str, value: Any) -> bool:
        key = self._norm(path)
        try:
            with self._lock:
                self._conn.execute(
                    "INSERT INTO kv(k, v) VALUES(?, ?) "
                    "ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                    (key, json.dumps(value, ensure_ascii=False)),
                )
                self._conn.commit()
            return True
        except Exception:
            return False

    def delete(self, path: str) -> bool:
        key = self._norm(path)
        try:
            with self._lock:
                self._conn.execute("DELETE FROM kv WHERE k = ? OR k LIKE ?", (key, key + "/%"))
                self._conn.commit()
            return True
        except Exception:
            return False

    def children(self, path: str) -> Dict[str, Any]:
        prefix = self._norm(path) + "/"
        out: Dict[str, Any] = {}
        with self._lock:
            rows = self._conn.execute(
                "SELECT k, v FROM kv WHERE k LIKE ?", (prefix + "%",)
            ).fetchall()
        for key, raw in rows:
            child = key[len(prefix) :].split("/")[0]
            try:
                val = json.loads(raw)
            except Exception:
                val = raw
            if "/" in key[len(prefix) :]:
                node = out.setdefault(child, {})
                if isinstance(node, dict):
                    sub = key[len(prefix) :].split("/", 1)[1]
                    node[sub] = val
            else:
                out[child] = val
        return out

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# FIREBASE RTDB BACKEND (website ke saath shared)
# ─────────────────────────────────────────────────────────────────────────────
class FirebaseStore(Store):
    backend = "firebase"

    def __init__(self, database_url: str, service_account: Dict[str, str]) -> None:
        import firebase_admin  # noqa: F401  (optional dependency)
        from firebase_admin import credentials, db

        cred = credentials.Certificate(
            {
                "type": "service_account",
                "project_id": service_account["project_id"],
                "client_email": service_account["client_email"],
                "private_key": service_account["private_key"],
            }
        )
        self._app = firebase_admin.initialize_app(
            cred, {"databaseURL": database_url, "httpTimeout": 20}
        )
        self._db = db

    def _ref(self, path: str):
        return self._db.reference("/" + path.strip("/"))

    def get(self, path: str) -> Any:
        try:
            return self._ref(path).get()
        except Exception:
            return None

    def set(self, path: str, value: Any) -> bool:
        try:
            self._ref(path).set(_jsonable(value))
            return True
        except Exception:
            return False

    def delete(self, path: str) -> bool:
        try:
            self._ref(path).delete()
            return True
        except Exception:
            return False

    def children(self, path: str) -> Dict[str, Any]:
        try:
            val = self._ref(path).get()
            return val if isinstance(val, dict) else {}
        except Exception:
            return {}


def _jsonable(value: Any) -> Any:
    """RTDB me None/empty-string keys allowed nahi hain → safe payload banao."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if v is None:
                continue
            key = str(k).replace(".", "_").replace("#", "_").replace("$", "_").replace("/", "_")
            if not key:
                continue
            out[key] = _jsonable(v)
        return out
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value if v is not None]
    return value


def _clean_private_key(raw: str) -> str:
    key = (raw or "").strip()
    if not key:
        return ""
    if key.startswith("{") and "private_key" in key:
        try:
            key = json.loads(key).get("private_key", "")
        except Exception:
            pass
    if key.startswith('"') and key.endswith('"'):
        key = key[1:-1]
    return key.replace("\\\\n", "\n").replace("\\n", "\n").strip()


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip().strip('"').strip("'").strip()


def create_store(verbose: bool = True) -> Store:
    """Firebase RTDB (preferred) → warna SQLite fallback."""
    project_id = _env("FIREBASE_PROJECT_ID")
    client_email = _env("FIREBASE_CLIENT_EMAIL")
    private_key = _clean_private_key(os.environ.get("FIREBASE_PRIVATE_KEY") or "")
    database_url = _env("FIREBASE_DATABASE_URL") or (
        "https://%s-default-rtdb.firebaseio.com" % project_id if project_id else ""
    )

    if project_id and client_email and private_key and database_url:
        try:
            store = FirebaseStore(database_url, {
                "project_id": project_id,
                "client_email": client_email,
                "private_key": private_key,
            })
            # chhota sa read/write probe
            store.set("bot_state/heartbeat", {"at": _now_ms(), "by": "bot"})
            if verbose:
                print("[store] ✅ Firebase RTDB connected: %s" % database_url)
            return store
        except ImportError:
            if verbose:
                print(
                    "[store] ⚠️ 'firebase-admin' install nahi hai → SQLite fallback.\n"
                    "        pip install firebase-admin   (website ke saath shared state ke liye zaroori)"
                )
        except Exception as exc:  # noqa: BLE001
            if verbose:
                print("[store] ⚠️ Firebase connect fail (%s) → SQLite fallback" % exc)
    elif verbose:
        print(
            "[store] ⚠️ Firebase env vars missing → SQLite fallback (bot_state.db).\n"
            "        Website ke saath shared state chahiye to FIREBASE_* vars set karein."
        )

    here = os.path.dirname(os.path.abspath(__file__))
    return SqliteStore(os.environ.get("BOT_STATE_DB") or os.path.join(here, "bot_state.db"))
