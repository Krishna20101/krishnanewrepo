#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
===============================================================================
 🤖 STUDY HELPER DOC — TELEGRAM DELIVERY BOT  ·  SINGLE FILE (bot/bot.py)
===============================================================================
 Ye EK file poora bot hai — pehle 5 files thi (vault.py, store.py, matcher.py,
 healthz.py, bot.py), ab sab yahan merge hain taaki hosting simple rahe:

     bot/bot.py  +  bot/requirements.txt     ← bas ye 2 files chahiye

 ── KAAM ─────────────────────────────────────────────────────────────────────
  1. Website ka "▶ OPEN IN TELEGRAM" deep link (?start=<requestId>) sambhalta hai
  2. 🔒 Channel join-gate (agar ON hai) — member nahi to join button, quota nahi katti
  3. 🛡 Anti-theft gate (single-use link, account binding, global breaker)
  4. Daily limit: 20 video / Telegram ID / din  → reset RAAT 12 BAJE IST (00:00)
  5. Lecture ko course groups me DHOONDHTA hai (caption-based scoring) ya seedha
     us message ko uthata hai jiska link admin ne diya ho
  6. Delivery:  PUBLIC channel + forwarding allowed → direct forward
                PRIVATE channel / noforward         → download + fresh upload
     Caption (fixed order):  📺 Title · 📚 Topic · 🎓 Course · Extracted By @credit
     Sath me notice: "This video will be deleted in 2 hours."
  7. Auto-delete (restart-safe queue) · admin commands · event log
  8. 🩺 Health server (Render free tier): /healthz /ready /status
  9. Admin "scan" task par group/channel scan karke course JSON khud bharta hai

 ── CRYPTO CONTRACT (website ke server.js se byte-compatible) ────────────────
     secret = ADMIN_SESSION_SECRET || ADMIN_EMAIL:ADMIN_PASSWORD:FIREBASE_PROJECT_ID
     key    = scrypt(secret, salt=b"shd_tg_media_vault_v3_2026", N=16384, r=8, p=1, 32)
     vault  = "v1.<b64url iv>.<b64url tag>.<b64url ct>"      (AES-256-GCM)
     media  = "tg_<b64url iv>_<b64url tag>_<b64url ct>"      (payload {c,m,k,s,n,mt,exp})

 ── CLI ──────────────────────────────────────────────────────────────────────
     python bot.py                → bot chalao (health server + supervisor retry)
     python bot.py --login        → bot ke liye ALAG user session banao
     python bot.py --selftest     → offline tests (koi network nahi)
     python bot.py --info         → creds/config/state summary
     python bot.py --print-session

 ⚠️  SESSION: website/bot ke liye ALAG session banayein. Ek hi session do jagah
     se khulne par Telegram use terminate kar deta hai (406 AUTH_KEY_DUPLICATED).
===============================================================================
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import hashlib
import json
import os
import re
import socket
import sqlite3
import struct
import sys
import threading
import time
import traceback
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)


# =============================================================================
# SECTION 1/5 · 🔐 VAULT — AES-256-GCM media tokens + Telegram credential resolver
#            (website ke src-side crypto ka exact mirror: salt shd_tg_media_vault_v3_2026)
# =============================================================================

VAULT_SALT = b"shd_tg_media_vault_v3_2026"
DEV_MASTER_SECRET = "shd_local_dev_master_key_v3"

TELEGRAM_DC_IPV4 = {
    1: "149.154.175.53",
    2: "149.154.167.51",
    3: "149.154.175.100",
    4: "149.154.167.91",
    5: "91.108.56.130",
}


def env(name: str) -> str:
    return (os.environ.get(name) or "").strip().strip('"').strip("'").strip()


def master_secret() -> str:
    """src/lib/tgCrypto.ts:getVaultMasterSecret() ka exact mirror."""
    explicit = env("ADMIN_SESSION_SECRET")
    if explicit:
        return explicit
    email, password, project = env("ADMIN_EMAIL"), env("ADMIN_PASSWORD"), env("FIREBASE_PROJECT_ID")
    if email and password and project:
        return "%s:%s:%s" % (email, password, project)
    if env("NODE_ENV").lower() == "production":
        return ""  # production me weak key use nahi karni — caller handle karega
    return DEV_MASTER_SECRET


def vault_key() -> Optional[bytes]:
    secret = master_secret()
    if not secret:
        return None
    return hashlib.scrypt(secret.encode("utf-8"), salt=VAULT_SALT, n=16384, r=8, p=1, dklen=32)


def _b64url_decode(raw: str) -> bytes:
    pad = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(raw + pad)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decrypt_vault_json(cipher_text: str) -> Optional[Any]:
    """`v1.<iv>.<tag>.<data>` → python object (fail par None)."""
    if not cipher_text or not str(cipher_text).startswith("v1."):
        return None
    key = vault_key()
    if key is None:
        return None
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        parts = str(cipher_text).split(".")
        if len(parts) != 4:
            return None
        iv = _b64url_decode(parts[1])
        tag = _b64url_decode(parts[2])
        data = _b64url_decode(parts[3])
        plain = AESGCM(key).decrypt(iv, data + tag, None)
        return json.loads(plain.decode("utf-8"))
    except Exception:
        return None


def encrypt_vault_json(payload: Any) -> str:
    """Website-compatible vault cipher banata hai (bot → website config save)."""
    key = vault_key()
    if key is None:
        return ""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    iv = os.urandom(12)
    sealed = AESGCM(key).encrypt(iv, json.dumps(payload, ensure_ascii=False).encode("utf-8"), None)
    data, tag = sealed[:-16], sealed[-16:]
    return "v1.%s.%s.%s" % (_b64url_encode(iv), _b64url_encode(tag), _b64url_encode(data))


# ─────────────────────────────────────────────────────────────────────────────
# GRAMJS  →  TELETHON  SESSION CONVERTER
# ─────────────────────────────────────────────────────────────────────────────
def _ip_to_bytes(ip: str) -> bytes:
    try:
        return socket.inet_pton(socket.AF_INET, ip)
    except OSError:
        try:
            return socket.inet_pton(socket.AF_INET6, ip)
        except OSError:
            return socket.inet_pton(socket.AF_INET, "149.154.167.91")


def parse_gramjs_session(session_string: str) -> Optional[Dict[str, Any]]:
    """session.py ke banaye GramJS string ko parse karta hai.

    Layout: '1' + base64( dcId:1 | addrLen:2(>h) | addr | port:2(>h) | authKey )
    """
    raw = (session_string or "").strip()
    if not raw:
        return None
    if raw.startswith("1"):
        raw = raw[1:]
    try:
        buf = base64.b64decode(raw + "=" * (-len(raw) % 4))
    except (binascii.Error, ValueError):
        return None
    if len(buf) < 6:
        return None
    try:
        dc_id = buf[0]
        addr_len = struct.unpack(">h", buf[1:3])[0]
        if addr_len <= 0 or addr_len > 64 or len(buf) < 3 + addr_len + 2:
            return None
        addr = buf[3 : 3 + addr_len].decode("utf-8", "ignore")
        port = struct.unpack(">h", buf[3 + addr_len : 5 + addr_len])[0]
        auth_key = buf[5 + addr_len :]
        if len(auth_key) < 64:
            return None
        return {
            "dcId": int(dc_id),
            "serverAddress": addr,
            "port": int(port or 443),
            "authKey": auth_key,
        }
    except Exception:
        return None


def gramjs_to_telethon(session_string: str) -> Optional[str]:
    """GramJS StringSession → Telethon StringSession (best-effort)."""
    parsed = parse_gramjs_session(session_string)
    if not parsed:
        return None
    dc_id = parsed["dcId"]
    addr = parsed["serverAddress"]
    if ":" in addr and dc_id in TELEGRAM_DC_IPV4:
        addr = TELEGRAM_DC_IPV4[dc_id]  # IPv6 → IPv4 (server-friendly)
    try:
        payload = (
            bytes([1])
            + bytes([dc_id])
            + _ip_to_bytes(addr)
            + struct.pack(">H", parsed["port"] or 443)
            + parsed["authKey"]
        )
        return base64.b64encode(payload).decode("ascii")
    except Exception:
        return None


def looks_like_telethon_session(session_string: str) -> bool:
    raw = (session_string or "").strip()
    if not raw:
        return False
    body = raw[1:] if raw.startswith("1") else raw
    try:
        buf = base64.b64decode(body + "=" * (-len(body) % 4))
    except (binascii.Error, ValueError):
        return False
    # Telethon layout: version(1) + dcId(1) + ip(4|16) + port(2) + authKey(256)
    return len(buf) in (264, 276) and buf[0] == 1


# ─────────────────────────────────────────────────────────────────────────────
# CREDENTIAL RESOLUTION  (env  >  Firebase vault  >  interactive login)
# ─────────────────────────────────────────────────────────────────────────────
def fetch_vault_credentials(store: Any) -> Dict[str, Any]:
    """Website ke encrypted vault se Telegram credentials padhta hai."""
    node = store.get("telegram_vault/encrypted_creds") or {}
    cipher = ""
    if isinstance(node, dict):
        cipher = str(node.get("cipher") or "")
    elif isinstance(node, str):
        cipher = node
    if not cipher:
        return {}
    data = decrypt_vault_json(cipher)
    return data if isinstance(data, dict) else {}


def resolve_credentials(store: Any, verbose: bool = True) -> Dict[str, Any]:
    """Final credentials: {apiId, apiHash, botToken, sessionString, sessionSource}.

    Priority:  1) bot ke apne env vars   2) Firebase vault (website wale)
    """
    vault = fetch_vault_credentials(store)

    api_id_raw = env("TELEGRAM_API_ID") or str(vault.get("apiId") or "")
    api_hash = env("TELEGRAM_API_HASH") or str(vault.get("apiHash") or "")
    bot_token = env("TELEGRAM_BOT_TOKEN") or env("BOT_TOKEN") or str(vault.get("botToken") or "")

    try:
        api_id = int(str(api_id_raw).strip())
    except (TypeError, ValueError):
        api_id = 0

    session_string = env("TG_SESSION_STRING") or env("TELEGRAM_SESSION_STRING_TELETHON")
    session_source = "env:TG_SESSION_STRING"

    if not session_string:
        gramjs = str(vault.get("sessionString") or env("TELEGRAM_SESSION_STRING") or "")
        if gramjs:
            if looks_like_telethon_session(gramjs):
                session_string = gramjs
                session_source = "vault (telethon format)"
            else:
                converted = gramjs_to_telethon(gramjs)
                if converted:
                    session_string = converted
                    session_source = "vault (converted from GramJS)"
                    if verbose:
                        print(
                            "[vault] ⚠️  Website wali GRAMJS session string ko Telethon me convert kiya.\n"
                            "[vault] ⚠️  EK HI SESSION 2 JAGAH use karne se Telegram session terminate kar\n"
                            "[vault] ⚠️  sakta hai (406 AUTH_KEY_DUPLICATED). Safe tareeka:\n"
                            "[vault] ⚠️      python3 bot.py --login   → bot ke liye ALAG session banayein\n"
                            "[vault] ⚠️      aur use TG_SESSION_STRING me daalein."
                        )

    return {
        "apiId": api_id,
        "apiHash": api_hash.strip(),
        "botToken": bot_token.strip(),
        "sessionString": session_string.strip(),
        "sessionSource": session_source if session_string else "",
    }


def check_credentials(creds: Dict[str, Any]) -> Tuple[bool, str]:
    missing = []
    if not creds.get("apiId"):
        missing.append("TELEGRAM_API_ID (my.telegram.org)")
    if not creds.get("apiHash"):
        missing.append("TELEGRAM_API_HASH (my.telegram.org)")
    if not creds.get("botToken"):
        missing.append("TELEGRAM_BOT_TOKEN (@BotFather)")
    if missing:
        return False, "Missing: " + ", ".join(missing)
    return True, "ok"


# =============================================================================
# SECTION 2/5 · 🗄 STORE — Firebase RTDB primary + SQLite fallback, config, quota, deletions
# =============================================================================

# ─────────────────────────────────────────────────────────────────────────────
# DEFAULT BOT CONFIG  (admin panel / bot commands se override hota hai)
# ─────────────────────────────────────────────────────────────────────────────
DEFAULT_CONFIG: Dict[str, Any] = {
    #: Har Telegram ID ek din me kitne video le sakta hai
    "dailyLimit": 20,
    #: 🕛 Quota kab reset ho — Indian time (Asia/Kolkata, UTC+5:30) ke hisaab se.
    #: 0 = RAAT 12 BAJE (midnight). Rolling window nahi, fixed daily reset.
    "dailyResetHourIST": 0,
    #: (legacy) purana rolling-window knob — ab daily reset use hota hai
    "quotaWindowHours": 24,
    #: Delivered video kitni der baad auto-delete ho
    "autoDeleteHours": 2,
    #: Caption credit — "Extracted By @<creditUsername>"
    "creditUsername": "krishna84",
    #: "auto"    = PUBLIC channel/group + forwarding allowed → direct forward
    #:             PRIVATE channel ya noforward/@handle → download + fresh upload  ← DEFAULT
    #: "clean"   = hamesha download + fresh upload (source kabhi nahi dikta)
    #: "forward" = hamesha forward (jab tak possible ho)
    "deliveryMode": "auto",
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


#: 🕛 Daily limit reset — Indian Standard Time (UTC+5:30, koi DST nahi)
IST_OFFSET_SEC = 5 * 3600 + 30 * 60


def daily_window_ms(cfg: Optional[Dict[str, Any]] = None, now_ms: Optional[int] = None) -> Tuple[int, int]:
    """Aaj ki IST day-window → (start_ms, end_ms).

    Reset `dailyResetHourIST` par hota hai (default 0 = raat 12 baje IST).
    Matlab 23:59 IST tak jo bhi liya, 00:00 IST par counter saaf.
    """
    cfg = cfg or {}
    now = float(now_ms if now_ms is not None else _now_ms()) / 1000.0
    try:
        reset_hour = int(cfg.get("dailyResetHourIST") or 0) % 24
    except (TypeError, ValueError):
        reset_hour = 0
    local = now + IST_OFFSET_SEC
    day_start_local = (int(local) // 86400) * 86400 + reset_hour * 3600
    if local < day_start_local:
        day_start_local -= 86400
    start_utc = day_start_local - IST_OFFSET_SEC
    return int(start_utc * 1000), int((start_utc + 86400) * 1000)


def reset_time_label(cfg: Optional[Dict[str, Any]] = None) -> str:
    """Daily reset ka waqt 12-hour format me → '12:00 AM' (default), '6:00 PM' …"""
    try:
        hour = int((cfg or {}).get("dailyResetHourIST") or 0) % 24
    except (TypeError, ValueError):
        hour = 0
    if hour == 0:
        return "12:00 AM"
    if hour == 12:
        return "12:00 PM"
    return "%d:00 %s" % (hour % 12, "AM" if hour < 12 else "PM")


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
        """🕛 Daily quota (IST): {limit, used, remaining, resetInSec, banned}.

        Reset raat 12 baje Indian time — `resetInSec` hamesha midnight tak ka
        bacha hua waqt batata hai (rolling window nahi).
        """
        cfg = self.get_config()
        user = self.get_user(tg_uid)
        limit = int(user.get("limit") if user.get("limit") is not None else cfg.get("dailyLimit") or 20)
        start_ms, end_ms = daily_window_ms(cfg)
        now = _now_ms()

        stamps: List[int] = [int(x) for x in (user.get("recent") or []) if x]
        fresh = [x for x in stamps if x >= start_ms]
        used = len(fresh)
        return {
            "limit": limit,
            "used": used,
            "remaining": max(0, limit - used),
            "resetInSec": max(0, int((end_ms - now) / 1000)),
            "resetsAtIST": "12:00 AM",
            "banned": bool(user.get("banned")),
            "totalVideos": int(user.get("totalVideos") or 0),
        }

    def consume_quota(self, tg_uid: int) -> Dict[str, Any]:
        """Ek delivery successful → quota + counters update."""
        cfg = self.get_config()
        user = self.get_user(tg_uid)
        start_ms, _end_ms = daily_window_ms(cfg)
        now = _now_ms()
        stamps = [int(x) for x in (user.get("recent") or []) if x]
        stamps = [x for x in stamps if x >= start_ms]
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
        # 🕛 AAJ (IST day-window) kitne video gaye
        start_ms, _end_ms = daily_window_ms(self.get_config())
        day = 0
        for u in users.values():
            if isinstance(u, dict):
                day += len([x for x in (u.get("recent") or []) if int(x) >= start_ms])
        out["videosToday"] = day
        out["videosLast24h"] = day  # legacy alias (purane admin panel ke liye)
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


# =============================================================================
# SECTION 3/5 · 🎯 MATCHER — caption parser, similarity scoring, delivery caption builder
# =============================================================================

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS / RULES
# ─────────────────────────────────────────────────────────────────────────────

#: Minimum combined score (0-100) to accept a candidate video.
MATCH_THRESHOLD = 60.0

#: Minimum course score (0-1) — course name match is MANDATORY.
COURSE_MIN = 0.34

#: Labels that can appear in a caption (order does NOT matter).
LABELS = {
    "index": r"(?:index|idx|sr\.?\s*no|s\.?no|no\.?|id|संख्या|क्रमांक)",
    "title": (
        r"(?:title|name|video\s*name|class\s*name|lecture\s*name|file\s*name|"
        r"lecture|video|class|pdf|file|शीर्षक|नाम|क्लास|वीडियो|लेक्चर)"
    ),
    "topic": (
        r"(?:topic|chapter|section|folder|sub\s*topic|syllabus|"
        r"टॉपिक|विषय\s*वस्तु|अध्याय|प्रकरण)"
    ),
    "course": (
        r"(?:batch|course|batch\s*name|course\s*name|program|programme|"
        r"बैच|कोर्स|पाठ्यक्रम)"
    ),
    "subject": r"(?:subject|sub|विषय)",
    "link": r"(?:link|url|youtube|yt|video\s*link|watch|लिंक)",
    "date": r"(?:date|uploaded|time|posted|दिनांक|तारीख)",
}

#: "Main keys" — ye course name ke pehchaan chinha hain (user rule: same course
#: name MANDATORY). Teen tiers hain:
#:   GRADE  → 12th / 11th / class 10   (dono taraf ho aur alag ho = REJECT)
#:   STRONG → मंजिल / परिवर्तन / Crash Course / NEET / Spoken English ...
#:            (dono taraf ho aur alag ho = REJECT)
#:   WEAK   → बैच / batch / course / 2027 / medium / science  (sirf bonus, reject nahi)
GRADE_KEY_RE = re.compile(
    r"(?:\b(?:9|10|11|12)\s*(?:th|वीं|वी)\b|\bclass\s*\d{1,2}\b|\b\d{1,2}\s*वीं\b)",
    re.IGNORECASE,
)
STRONG_KEY_RE = re.compile(
    r"(?:"
    r"\bcrash\s*course\b|\bfoundation\b|\btarget\b|\bmanzil\b|मंजिल|"
    r"\bparivartan\b|परिवर्तन|\budaan\b|उड़ान|\bsankalp\b|संकल्प|\bnucleus\b|"
    r"आरंभ|\barambh\b|\bpragati\b|प्रगति|\bjee\b|\bneet\b|\baiims\b|\bcuqet\b|"
    r"\bbiceps\b|\bboard(?:s)?\b|\bpre[\s-]?board(?:s)?\b|\bolympiad\b|"
    r"\bspoken\s*english\b|\benglish\s*(?:batch|course)\b|\bgrammar\b|"
    r"\bcomplete\s*batch\b|\bfull\s*course\b|\brecorded\b|\blive\b"
    r")",
    re.IGNORECASE,
)
WEAK_KEY_RE = re.compile(
    r"(?:\bbatch\b|बैच|\bcourse\b|कोर्स|\bprogram(?:me)?\b|\b20\d{2}\b|"
    r"\bhindi\b|हिंदी|हिन्दी|\benglish\b|अंग्रेजी|\bmedium\b|\bscience\b|विज्ञान|"
    r"\bcommerce\b|वाणिज्य|\barts\b|\bhumanities\b|\bstream\b)",
    re.IGNORECASE,
)
#: Combined (detect ke liye, e.g. caption line course wali hai ya nahi)
COURSE_KEY_RE = re.compile(
    r"(?:%s|%s|%s)" % (GRADE_KEY_RE.pattern, STRONG_KEY_RE.pattern, WEAK_KEY_RE.pattern),
    re.IGNORECASE,
)

#: @username / t.me link / extractor watermark — ALWAYS removed (mandatory).
USERNAME_RE = re.compile(r"(?<![\w])@[\w]{3,32}(?![\w])")
TG_LINK_RE = re.compile(
    r"(?:https?://)?(?:t\.me|telegram\.(?:me|org|dog))[:/][\w/+.\-]+",
    re.IGNORECASE,
)
EXTRACTOR_LINE_RE = re.compile(
    r"^\s*(?:extracted|downloaded|uploaded|shared|powered|posted|credit|"
    r"source|from|channel|group|credit\s*goes)\s*(?:by|to|from)?\s*[:\-–—]?\s*.*$",
    re.IGNORECASE,
)
ERROR_LOG_RE = re.compile(
    r"(?:\berror\b|\btraceback\b|\bexception\b|\bwarning\b|"
    r"['\"]?utf-?8['\"]?\s*codec|can'?t\s+decode|yt-?dlp|ffmpeg|extractor)",
    re.IGNORECASE,
)
YOUTUBE_RE = re.compile(
    r"(?:https?://)?(?:www\.|m\.)?(?:youtube\.com/(?:watch\?v=|embed/|live/|shorts/|v/)"
    r"|youtu\.be/)([A-Za-z0-9_-]{6,})",
    re.IGNORECASE,
)
FILE_EXT_RE = re.compile(
    r"\.(mp4|mkv|webm|mov|avi|flv|m4v|ts|pdf|docx|pptx|zip|rar)\b",
    re.IGNORECASE,
)
#: Decorative watermark unicode (arrows, eagles, tibetan marks, superscripts...)
#: ASCII + Devanagari + common symbols ke alawa sab hata do.
DECOR_RE = re.compile(r"[^\x20-\x7E\u0900-\u097F₹•–—…]+")
PART_RE = re.compile(
    r"(?:\bpart|\blec(?:ture)?|\bclass|\bday|\bep(?:isode)?|\bभाग|\bपार्ट|"
    r"\bखंड)\s*[-–—:#.]*\s*0*(\d{1,3})\b",
    re.IGNORECASE,
)


# ─────────────────────────────────────────────────────────────────────────────
# TEXT CLEANING
# ─────────────────────────────────────────────────────────────────────────────
def strip_usernames(text: str) -> str:
    """@username + t.me links hata deta hai (MANDATORY rule).

    "Extracted By" jaisa plain text reh sakta hai, lekin uske saath ka
    @handle kabhi nahi rehna chahiye.
    """
    if not text:
        return ""
    s = TG_LINK_RE.sub(" ", text)
    s = USERNAME_RE.sub(" ", s)
    return re.sub(r"[ \t]{2,}", " ", s).strip()


def clean_text(text: str, drop_extractor_lines: bool = True) -> str:
    """Caption/title ko display-safe banata hai (watermark, logs, @handle)."""
    if not text:
        return ""
    s = str(text).replace("\r\n", "\n")
    s = strip_usernames(s)

    out_lines: List[str] = []
    for line in s.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        if ERROR_LOG_RE.search(stripped):
            continue
        if drop_extractor_lines and EXTRACTOR_LINE_RE.match(stripped):
            # "Extracted By: xyz" → line drop (aur @handle pehle hi hat chuka)
            continue
        out_lines.append(stripped)

    s = "\n".join(out_lines)
    s = FILE_EXT_RE.sub("", s)
    s = DECOR_RE.sub(" ", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    return s.strip(" \t-–—:|•\n")


def normalize(text: str) -> str:
    """Compare ke liye canonical form: NFKC + lowercase + sirf word chars."""
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", str(text)).lower()
    s = strip_usernames(s)
    # part/lecture numbers ko canonical banao: "part -2", "part 02" → "part 2"
    s = PART_RE.sub(lambda m: " part %s " % int(m.group(1)), s)
    s = FILE_EXT_RE.sub(" ", s)
    s = re.sub(r"[^0-9a-z\u0900-\u097F]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def tokenize(text: str) -> List[str]:
    return [t for t in normalize(text).split(" ") if len(t) >= 1]


def extract_part_number(text: str) -> Optional[int]:
    if not text:
        return None
    m = PART_RE.search(text)
    if not m:
        m2 = re.search(r"[-–—]\s*0*(\d{1,3})\s*$", text.strip())
        if m2:
            return int(m2.group(1))
        return None
    return int(m.group(1))


def _char_bigrams(s: str) -> set:
    s = s.replace(" ", "")
    if len(s) <= 1:
        return {s} if s else set()
    return {s[i : i + 2] for i in range(len(s) - 1)}


def similarity(a: str, b: str) -> float:
    """0.0 - 1.0 fuzzy similarity (Hindi/Devanagari + English dono ke liye)."""
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if len(na) >= 6 and (na in nb or nb in na):
        return 0.9

    ta, tb = set(tokenize(na)), set(tokenize(nb))
    if not ta or not tb:
        return 0.0
    inter = ta & tb
    jaccard = len(inter) / len(ta | tb)
    containment = len(inter) / min(len(ta), len(tb))

    ba, bb = _char_bigrams(na), _char_bigrams(nb)
    dice = (2 * len(ba & bb) / (len(ba) + len(bb))) if (ba and bb) else 0.0

    return round(jaccard * 0.5 + containment * 0.28 + dice * 0.22, 4)


def _key_set(pattern: "re.Pattern[str]", text: str) -> set:
    if not text:
        return set()
    out = set()
    for m in pattern.finditer(text):
        key = normalize(m.group(0))
        if key:
            out.add(key)
    return out


def course_keys(text: str) -> set:
    """Saare course keys (grade + strong + weak) — diagnostics ke liye."""
    keys = _key_set(GRADE_KEY_RE, text or "")
    keys |= _key_set(STRONG_KEY_RE, text or "")
    keys |= _key_set(WEAK_KEY_RE, text or "")
    for m in re.finditer(r"\b(20\d{2})\b", normalize(text or "")):
        keys.add(m.group(1))
    keys.discard("")
    return keys


def informative_course_keys(text: str) -> set:
    """Sirf 'main' keys (grade + strong) — यही match hona MANDATORY hai."""
    keys = _key_set(GRADE_KEY_RE, text or "")
    keys |= _key_set(STRONG_KEY_RE, text or "")
    keys.discard("")
    return keys


def course_match_score(a: str, b: str) -> float:
    """COURSE NAME match — MANDATORY rule.

    • 12th vs 11th              → 0.0 (REJECT)
    • मंजिल vs परिवर्तन          → 0.0 (REJECT)
    • 12th मंजिल vs 12th मंजिल 27 → ~1.0 (ACCEPT, year/wording farak ignore)
    """
    ia, ib = informative_course_keys(a), informative_course_keys(b)

    if not ia and not ib:
        # Koi main key nahi → sirf text similarity (discount ke saath)
        return round(similarity(a, b) * 0.75, 4)

    if not ia or not ib:
        # Ek taraf main key hai, dusri taraf nahi → weak match
        base = similarity(a, b)
        return round(base * 0.5, 4) if base >= 0.6 else 0.0

    # ── Hard guards (main keys alag = course alag) ─────────────────────────
    ga, gb = _key_set(GRADE_KEY_RE, a or ""), _key_set(GRADE_KEY_RE, b or "")
    if ga and gb and not (ga & gb):
        return 0.0
    sa, sb = _key_set(STRONG_KEY_RE, a or ""), _key_set(STRONG_KEY_RE, b or "")
    if sa and sb and not (sa & sb):
        return 0.0

    shared = ia & ib
    if not shared:
        return 0.0
    union = ia | ib
    base = len(shared) / max(1, len(union))
    return round(min(1.0, base * 0.75 + similarity(a, b) * 0.25), 4)


# ─────────────────────────────────────────────────────────────────────────────
# CAPTION PARSING  (order-independent)
# ─────────────────────────────────────────────────────────────────────────────
def parse_caption(caption: str, file_name: str = "") -> Dict[str, Any]:
    """Caption se title / topic / course / subject / index / link nikalta hai.

    Labels kahin bhi hon (upar-neeche), sab padhe jate hain. Bina label wale
    lines heuristic se classify hote hain.
    """
    raw = (caption or "").replace("\r\n", "\n")
    lines = [ln.strip() for ln in raw.split("\n") if ln.strip()]

    found: Dict[str, str] = {}
    index_num: Optional[int] = None
    youtube = ""
    rest: List[str] = []

    combined_labels = "|".join(LABELS.values())
    label_re = re.compile(r"^(%s)\s*[:\-–—]\s*(.+)$" % combined_labels, re.IGNORECASE)

    for line in lines:
        yt = YOUTUBE_RE.search(line)
        if yt and not youtube:
            youtube = "https://www.youtube.com/watch?v=%s" % yt.group(1)

        m = label_re.match(line)
        if m:
            label_raw, value = m.group(1), m.group(2).strip()
            key = _label_key(label_raw)
            if key == "index":
                digits = re.sub(r"\D", "", value)
                if digits and index_num is None:
                    index_num = int(digits[:6])
                continue
            if key == "link":
                continue  # link upar hi capture ho chuka
            if key and value and key not in found:
                found[key] = value
                continue
            if key and value and key in found:
                found[key] = "%s %s" % (found[key], value)
                continue
        rest.append(line)

    # ── Bina label wale lines ki heuristic classification ───────────────────
    topic_guess = ""
    course_guess = ""
    title_guess = ""
    for line in rest:
        if ERROR_LOG_RE.search(line) or EXTRACTOR_LINE_RE.match(line):
            continue
        has_course_key = bool(COURSE_KEY_RE.search(line))
        has_part = bool(PART_RE.search(line))
        if has_course_key and not course_guess and not has_part:
            course_guess = line
            continue
        if has_course_key and has_part and not title_guess:
            # "12th मंजिल बैच Crash Course - Chemistry Part 1" → title (course bhi)
            title_guess = line
            if not course_guess:
                course_guess = line
            continue
        if not title_guess:
            title_guess = line
        elif not topic_guess:
            topic_guess = line

    title = clean_text(found.get("title") or title_guess or file_name or "")
    if not title and file_name:
        title = clean_text(file_name)

    topic = clean_text(found.get("topic") or topic_guess)
    course = clean_text(found.get("course") or course_guess)
    subject = clean_text(found.get("subject"))

    return {
        "title": title,
        "topic": topic,
        "course": course,
        "subject": subject,
        "index": index_num,
        "youtube_url": youtube,
        "part": extract_part_number(title or topic),
        "raw": raw,
    }


def _label_key(label_raw: str) -> str:
    lab = label_raw.strip().lower()
    for key, pattern in LABELS.items():
        if re.fullmatch(pattern.replace("(?:", "(?:").strip(), lab, re.IGNORECASE):
            return key
    # fallback: pehla word dekh lo
    first = re.sub(r"[^a-z\u0900-\u097F]", "", lab)
    for key in LABELS:
        if first and first.startswith(key[:4]):
            return key
    return ""


# ─────────────────────────────────────────────────────────────────────────────
# CANDIDATE SCORING + DEDUPE
# ─────────────────────────────────────────────────────────────────────────────
#: 📂 Generic folder-naam — inke hone par "course mismatch" reject nahi hota
#: (poori course ek hi "All Study Material" / "PDF" folder me padi ho sakti hai).
GENERIC_COURSE_LABELS = frozenset(
    {
        "all", "study", "material", "materials", "lecture", "lectures", "class",
        "classes", "video", "videos", "pdf", "pdfs", "note", "notes", "handwritten",
        "file", "files", "document", "documents", "content", "misc", "miscellaneous",
        "other", "others", "extra", "extras", "batch", "course", "courses", "subject",
        "subjects", "syllabus", "complete", "telegram", "channel", "group", "uploads",
        "upload", "media", "folder", "data", "book", "books", "important", "best",
        "new", "old", "free", "top", "series", "collection", "library",
    }
)


def _is_generic_course_label(value: Any) -> bool:
    """True agar yeh label ek GENERIC folder-naam hai (specific course ka naam nahi).

    "All Study Material", "PDF", "Notes", "" → True
    "12th मंजिल बैच 2027", "Spoken English Batch 2026" → False
    """
    norm = normalize(value)
    if not norm:
        return True
    # Devanagari (Hindi) text specific maana jata hai — batch naam aksar Hindi me hote hain
    if re.search(r"[\u0900-\u097F]", str(value or "")):
        return False
    tokens = [t for t in tokenize(norm) if t and t not in ("the", "of", "for", "and", "in", "on")]
    if not tokens:
        return True
    return all(t in GENERIC_COURSE_LABELS for t in tokens)


def flexible_course_score(
    req_course: Any, req_topic: Any, c_course: Any, c_topic: Any, c_title: Any
) -> Tuple[float, str]:
    """Course naam alag-alag field me hone par bhi match dhoondhta hai → (score, note).

      1. request ka topic-path  vs caption ka course   (course naam folder me tha)
      2. caption ka topic       vs request ka course   (ulta likha ho)
      3. request ka course      vs caption ka title    (course naam title me ho)
      4. koi ek taraf GENERIC label ("All Study Material") → reject nahi, 0.45
    """
    best = 0.0
    note = "course-alt"
    for a, b, label in (
        (req_topic, c_course, "topic-vs-course"),
        (req_course, c_topic, "course-vs-topic"),
        (req_course, c_title, "course-vs-title"),
    ):
        if not a or not b:
            continue
        score = course_match_score(a, b)
        if score > best:
            best, note = score, "course-alt(%s)" % label

    if best >= COURSE_MIN:
        return best, note

    if _is_generic_course_label(req_course) or _is_generic_course_label(c_course):
        return max(best, 0.45), "course-alt(generic-label)"

    return best, note


def score_candidate(request: Dict[str, Any], candidate: Dict[str, Any]) -> Dict[str, Any]:
    """Website request vs Telegram message candidate → 0-100 score + reason."""
    parsed = candidate.get("parsed") or parse_caption(
        candidate.get("caption", ""), candidate.get("file_name", "")
    )

    req_title = request.get("title") or ""
    req_topic = request.get("topic") or ""
    req_course = request.get("courseName") or request.get("course") or ""

    c_title = parsed.get("title") or candidate.get("file_name") or ""
    c_topic = parsed.get("topic") or ""
    c_course = parsed.get("course") or candidate.get("chat_title") or ""

    title_sim = similarity(req_title, c_title)
    # 🧩 FOLDER-SKIP TOLERANCE: topic (chapter/folder) dono taraf se na mile to
    #    uska 0.18 weight TITLE me chala jata hai — folder skip hone se match
    #    nahi toot-ta. Ek taraf topic ho to title se partial compare hota hai.
    have_topic = bool(req_topic) and bool(c_topic)
    if have_topic:
        topic_sim = similarity(req_topic, c_topic)
    elif req_topic and not c_topic:
        topic_sim = similarity(req_topic, c_title) * 0.6
    else:
        topic_sim = 0.0
    course_score = course_match_score(req_course, c_course)

    # ── Hard guards ────────────────────────────────────────────────────────
    req_part = request.get("part") or extract_part_number(req_title)
    c_part = parsed.get("part") or extract_part_number(c_title)
    if req_part and c_part and int(req_part) != int(c_part):
        return {
            "score": 0.0,
            "reason": "part-mismatch (part %s vs part %s)" % (req_part, c_part),
            "titleSim": round(title_sim, 3),
            "topicSim": round(topic_sim, 3),
            "courseScore": round(course_score, 3),
            "parsed": parsed,
        }

    # 🧠 COURSE-NAME FLEXIBILITY (owner rule): topic ka naam aur course ka naam
    #    kabhi-kabhi alag jagah likhe hote hain — jaise "Crash Course 2026" ki
    #    lecture "All Study Material" folder ke andar pade. Isliye pehla course
    #    compare fail ho to naam ko topic / title / path me bhi dhoondhte hain.
    #    Ek taraf GENERIC folder-naam ho to reject nahi karte.
    #    Lekin DONO taraf specific aur alag course likha ho
    #    ("12th मंजिल बैच" vs "11th परिवर्तन बैच") → hard reject, warna student
    #    ko galat batch ki video chali jati.
    course_note = ""
    if course_score < COURSE_MIN:
        alt_score, alt_note = flexible_course_score(
            req_course=req_course,
            req_topic=req_topic,
            c_course=c_course,
            c_topic=c_topic,
            c_title=c_title,
        )
        if alt_score >= COURSE_MIN:
            course_score, course_note = alt_score, " " + alt_note
        else:
            return {
                "score": 0.0,
                "reason": "course-name mismatch (best alt %.2f)" % alt_score,
                "titleSim": round(title_sim, 3),
                "topicSim": round(topic_sim, 3),
                "courseScore": round(course_score, 3),
                "parsed": parsed,
            }

    # weights: topic info na ho to uska hissa title ko
    w_title, w_topic, w_course = (0.50, 0.18, 0.32) if have_topic else (0.68, 0.00, 0.32)
    score = 100.0 * (w_title * title_sim + w_topic * topic_sim + w_course * course_score)

    # size close ho to bonus (same file hone ka strong signal)
    req_size = int(request.get("fileSize") or 0)
    c_size = int(candidate.get("file_size") or 0)
    if req_size and c_size:
        ratio = min(req_size, c_size) / max(req_size, c_size)
        if ratio > 0.97:
            score += 6.0
        elif ratio < 0.5:
            score -= 8.0

    return {
        "score": round(min(100.0, score), 2),
        "reason": "title=%.2f topic=%.2f course=%.2f%s"
        % (title_sim, topic_sim, course_score, course_note),
        "titleSim": round(title_sim, 3),
        "topicSim": round(topic_sim, 3),
        "courseScore": round(course_score, 3),
        "parsed": parsed,
    }


def dedupe_candidates(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Same video 2 channel me ho to SIRF best match rakhta hai."""
    best: Dict[str, Dict[str, Any]] = {}
    for cand in candidates:
        parsed = cand.get("parsed") or {}
        key_title = normalize(parsed.get("title") or cand.get("file_name") or "")[:60]
        size_mb = round(int(cand.get("file_size") or 0) / (1024 * 1024))
        dur = round(int(cand.get("duration") or 0) / 15.0)
        key = "%s|%s|%s" % (key_title, size_mb, dur)
        prev = best.get(key)
        if prev is None or cand.get("score", 0) > prev.get("score", 0):
            best[key] = cand
    out = list(best.values())
    out.sort(key=lambda c: (-float(c.get("score") or 0), -int(c.get("file_size") or 0)))
    return out


def pick_best(candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """🏆 Sabse zyada match wala candidate — kai groups me same naam mile to
    jo score sabse high hai wahi jeet-ta hai (tie par size-match, fir naya msg)."""
    deduped = dedupe_candidates(candidates)

    def sort_key(cand: Dict[str, Any]) -> Tuple[float, float, int]:
        score = float(cand.get("score") or 0)
        size = float(cand.get("file_size") or 0)
        return (round(score, 2), size, int(cand.get("message_id") or 0))

    for cand in sorted(deduped, key=sort_key, reverse=True):
        if float(cand.get("score") or 0) >= MATCH_THRESHOLD:
            return cand
    return None


def search_query(title: str, topic: str = "") -> str:
    """Telegram server-side search ke liye chhoti distinctive query."""
    base = clean_text(title)
    base = re.sub(r"\b(?:part|lecture|class)\b\s*[-–—:#.]*\s*\d{1,3}\b", " ", base, flags=re.I)
    words = [w for w in tokenize(base) if len(w) >= 3][:5]
    if not words:
        words = [w for w in tokenize(topic) if len(w) >= 3][:4]
    return " ".join(words)[:90].strip()


# ─────────────────────────────────────────────────────────────────────────────
# DELIVERY CAPTION  (naya, apna caption — English)
# ─────────────────────────────────────────────────────────────────────────────
def build_delivery_caption(
    title: str,
    topic: str = "",
    course: str = "",
    credit_username: str = "krishna84",
    extra: str = "",
) -> str:
    """User rule: 1) Title  2) Topic (folder-wise)  3) Course  4) Extracted By @credit.

    Telegram caption limit = 1024 chars, isliye safe trim bhi hota hai.
    """
    title = clean_text(title)[:180] or "Lecture"
    topic = clean_text(topic)[:160]
    course = clean_text(course)[:160]
    credit = re.sub(r"^@+", "", (credit_username or "krishna84").strip())[:32]

    lines: List[str] = ["📺 %s" % title]
    if topic:
        lines.append("📚 Topic: %s" % topic)
    if course:
        lines.append("🎓 Course: %s" % course)
    if extra:
        lines.append(clean_text(extra)[:120])
    lines.append("")
    lines.append("Extracted By @%s" % credit)

    caption = "\n".join(lines)
    # @username kabhi leak na ho (sirf apna credit handle allowed)
    caption = _keep_only_credit_handle(caption, credit)
    if len(caption) > 1000:
        caption = caption[:1000].rstrip() + "…"
    return caption


def _keep_only_credit_handle(text: str, credit: str) -> str:
    allowed = "@%s" % credit

    def repl(m: "re.Match[str]") -> str:
        return allowed if m.group(0).lower() == allowed.lower() else " "

    out = USERNAME_RE.sub(repl, text)
    return re.sub(r"[ \t]{2,}", " ", out)


def safe_display_name(name: str, fallback: str = "lecture.mp4") -> str:
    base = clean_text(name, drop_extractor_lines=True) or fallback
    base = base.replace("/", "-").replace("\\", "-").strip()[:150]
    if not base:
        base = fallback
    if not re.search(r"\.[A-Za-z0-9]{2,4}$", base):
        base += ".mp4"
    return base


# ─────────────────────────────────────────────────────────────────────────────
# SELF TEST  →  python3 matcher.py
# ─────────────────────────────────────────────────────────────────────────────
def _selftest() -> int:
    failures: List[str] = []

    def check(name: str, cond: bool, extra: Any = "") -> None:
        if not cond:
            failures.append("%s %s" % (name, extra))

    # 1. @username strip
    check(
        "strip @username",
        strip_usernames("Solid State Part 1 @leakedchannel Extracted By: @someone")
        == "Solid State Part 1 Extracted By:",
        strip_usernames("Solid State Part 1 @leakedchannel Extracted By: @someone"),
    )
    check("strip t.me link", strip_usernames("join t.me/xyz now") == "join now")
    check(
        "no @ in delivery caption",
        "@" not in build_delivery_caption(
            "Solid State", "Chemistry", "12th मंजिल", "leakchannel"
        ).replace("@leakchannel", ""),
    )

    # 2. Caption parsing — 3 different field orders
    cap_a = (
        "Index: 42\n"
        "Title: Solid State Part 1\n"
        "Batch: 12th मंजिल बैच 2027\n"
        "Topic: Chemistry - Solid State\n"
        "Extracted By: @somechannel\n"
    )
    cap_b = (
        "Topic: Solid State\n"
        "Course: 12th मंजिल बैच 2027\n"
        "Title: Solid State Part 1\n"
    )
    cap_c = "12th मंजिल बैच 2027\nChemistry - Solid State\nPart 1 (Full Chapter)\n"

    pa, pb, pc = parse_caption(cap_a), parse_caption(cap_b), parse_caption(cap_c)
    check("A title", "solid state" in normalize(pa["title"]), pa["title"])
    check("A index", pa["index"] == 42, pa["index"])
    check("A course", "मंजिल" in pa["course"], pa["course"])
    check("B title", "solid state" in normalize(pb["title"]), pb["title"])
    check("B course", "मंजिल" in pb["course"], pb["course"])
    check("B topic", "solid state" in normalize(pb["topic"]), pb["topic"])
    check("C course", "मंजिल" in pc["course"], pc["course"])
    check("C title", normalize(pc["title"]) != "", pc["title"])
    check("A no @", "@" not in pa["title"] and "@" not in pa["course"])

    # 3. Course match MANDATORY
    check(
        "same course keys",
        course_match_score("12th मंजिल बैच 2027", "12th मंजिल बैच 2026-27") > COURSE_MIN,
    )
    check(
        "different course rejected",
        course_match_score("12th मंजिल बैच 2027", "11th परिवर्तन बैच 2027") == 0.0,
        course_match_score("12th मंजिल बैच 2027", "11th परिवर्तन बैच 2027"),
    )
    check(
        "different class rejected",
        course_match_score("12th Science Crash Course", "10th Science Crash Course") == 0.0,
    )

    # 4. Fuzzy title similarity (Hindi + English, thoda aage-peeche)
    check(
        "fuzzy title",
        similarity("Solid State Part 1 Chemistry", "Chemistry Solid State part 1") > 0.7,
        similarity("Solid State Part 1 Chemistry", "Chemistry Solid State part 1"),
    )
    check("hindi fuzzy", similarity("ठोस अवस्था भाग 2", "ठोस अवस्था Part 2") > 0.5)

    # 5. Part guard — Part 1 kabhi Part 2 se match na ho
    req = {
        "title": "Solid State Part 1",
        "topic": "Chemistry",
        "courseName": "12th मंजिल बैच 2027",
        "fileSize": 400 * 1024 * 1024,
    }
    good = {
        "caption": cap_a,
        "file_name": "Solid State Part 1.mp4",
        "file_size": 401 * 1024 * 1024,
        "chat_title": "12th मंजिल बैच 2027",
    }
    wrong_part = dict(good, caption=cap_a.replace("Part 1", "Part 2"))
    wrong_course = dict(
        good, caption=cap_a.replace("12th मंजिल बैच 2027", "11th परिवर्तन बैच 2027")
    )
    s_good = score_candidate(req, good)
    s_part = score_candidate(req, wrong_part)
    s_course = score_candidate(req, wrong_course)
    check("good match >= threshold", s_good["score"] >= MATCH_THRESHOLD, s_good)
    check("part mismatch rejected", s_part["score"] == 0.0, s_part)
    check("course mismatch rejected", s_course["score"] == 0.0, s_course)

    # 6. Dedupe — 2 channel me same video, best chuna jaye
    dupes = [
        dict(good, score=72.0, chat_id=-1001, message_id=11),
        dict(good, score=91.0, chat_id=-1002, message_id=22),
        dict(good, score=64.0, chat_id=-1003, message_id=33),
    ]
    best = pick_best(dupes)
    check("dedupe picks best", best is not None and best["message_id"] == 22, best)
    check("dedupe keeps 1", len(dedupe_candidates(dupes)) == 1, len(dedupe_candidates(dupes)))

    # 7. Delivery caption format (Title → Topic → Course → credit)
    cap = build_delivery_caption(
        "Solid State Part 1", "Chemistry > Solid State", "12th मंजिल बैच 2027", "krishna84"
    )
    check("caption title first", cap.splitlines()[0].endswith("Solid State Part 1"), cap)
    check("caption topic", "Topic: Chemistry" in cap, cap)
    check("caption course", "Course: 12th मंजिल बैच 2027" in cap, cap)
    check("caption credit", cap.rstrip().endswith("Extracted By @krishna84"), cap)

    # 8. Search query
    q = search_query("Solid State Part 1 Full Chapter", "Chemistry")
    check("search query no part", "part" not in q.lower(), q)

    # 9. 🧠 Generic course label — "All Study Material" ke andar "Crash Course 2026"
    generic_req = {
        "title": "Crash Course 2026 Physics Full Test Discussion",
        "topic": "",
        "courseName": "All Study Material",
        "fileSize": 250 * 1024 * 1024,
    }
    generic_cand = {
        "caption": (
            "Index: 11\nTitle: Crash Course 2026 Physics Full Test Discussion\n"
            "Batch: Crash Course 2026\nTopic: Physics\n"
        ),
        "file_name": "Crash Course 2026 Physics Full Test Discussion.mp4",
        "file_size": 251 * 1024 * 1024,
        "chat_title": "Physics Wallah",
    }
    s_generic = score_candidate(generic_req, generic_cand)
    check(
        "generic course label matches (All Study Material → Crash Course 2026)",
        s_generic["score"] >= MATCH_THRESHOLD,
        s_generic,
    )
    check("_is_generic_course_label: All Study Material", _is_generic_course_label("All Study Material"))
    check("_is_generic_course_label: PDF", _is_generic_course_label("PDF"))
    check("_is_generic_course_label: empty", _is_generic_course_label(""))
    check(
        "_is_generic_course_label: specific english course",
        not _is_generic_course_label("Spoken English Batch 2026"),
    )
    check(
        "_is_generic_course_label: hindi course",
        not _is_generic_course_label("12th मंजिल बैच 2027"),
    )

    # 10. Course naam caption ke TOPIC me ho (ulta likha) → cross-field match
    cross_req = {
        "title": "Solid State Part 1",
        "topic": "Chemistry",
        "courseName": "12th Science Crash Course",
        "fileSize": 400 * 1024 * 1024,
    }
    cross_cand = {
        "caption": (
            "Title: Solid State Part 1\nTopic: 12th Science Crash Course - Chemistry\n"
            "Batch: All Lectures\n"
        ),
        "file_name": "Solid State Part 1.mp4",
        "file_size": 400 * 1024 * 1024,
        "chat_title": "Study Group",
    }
    s_cross = score_candidate(cross_req, cross_cand)
    check("course name found in caption topic", s_cross["score"] >= MATCH_THRESHOLD, s_cross)

    # 11. 📂 Folder skip — candidate par topic bilkul na ho, tab bhi match mile
    skip_cand = {
        "caption": "Title: Solid State Part 1\nBatch: 12th मंजिल बैच 2027\n",
        "file_name": "Solid State Part 1.mp4",
        "file_size": 400 * 1024 * 1024,
        "chat_title": "12th मंजिल बैच 2027",
    }
    s_skip = score_candidate(req, skip_cand)
    check("folder skipped (no topic) still matches", s_skip["score"] >= MATCH_THRESHOLD, s_skip)

    # 12. 🏆 Same naam kai groups me → SABSE zyada match wala group jeete
    many = [
        dict(good, score=61.0, chat_id=-1001, message_id=11),
        dict(good, score=88.5, chat_id=-1002, message_id=22),
        dict(good, score=74.0, chat_id=-1003, message_id=33),
    ]
    top = pick_best(many)
    check("pick_best = highest score", top is not None and abs(top["score"] - 88.5) < 0.01, top)
    below = [dict(good, score=59.9, chat_id=-1001, message_id=11)]
    check("pick_best below threshold = None", pick_best(below) is None, pick_best(below))

    if failures:
        print("❌ SELF-TEST FAILED (%d):" % len(failures))
        for f in failures:
            print("   - %s" % f)
        return 1

    print("✅ matcher.py self-test passed (all caption/match/dedupe/caption rules OK)")
    return 0


# =============================================================================
# SECTION 4/5 · 🩺 HEALTH — stdlib HTTP server (Render free tier Web Service ke liye PORT bind)
# =============================================================================

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


# =============================================================================
# SECTION 5/5 · 🤖 BOT — delivery, join-gate, anti-theft, scanner, admin commands, CLI
# =============================================================================


# ─────────────────────────────────────────────────────────────────────────────
# ENGLISH-ONLY USER MESSAGES  (user rule: kabhi Hindi nahi)
# ─────────────────────────────────────────────────────────────────────────────
MSG_WELCOME = (
    "👋 Welcome to {app}!\n\n"
    "Open any lecture on the website and tap ▶ OPEN IN TELEGRAM.\n"
    "This bot will send that video here within a few minutes.\n\n"
    "📌 Your daily limit: {limit} videos per day\n"
    "🕛 The limit resets at {resetTime} (Indian time)\n"
    "⏳ Every video is deleted automatically after {hours} hours\n\n"
    "Commands: /status  /help"
)
MSG_HELP = (
    "ℹ️ How to use this bot\n\n"
    "1. Open the lecture on {app}\n"
    "2. Tap ▶ OPEN IN TELEGRAM\n"
    "3. Come back here — the video will arrive with live progress\n\n"
    "📌 Daily limit: {limit} videos per day (resets at {resetTime} Indian time)\n"
    "⏳ Videos are auto-deleted after {hours} hours\n"
    "🚫 Never share this chat — your limit is linked to your Telegram account\n\n"
    "Commands:\n"
    "/status — check your remaining limit\n"
    "/find <course> | <title> — search a lecture manually"
)
MSG_HELP_ADMIN = (
    "\n\n🛠 Admin commands\n"
    "/stats — users, videos sent, pending deletions\n"
    "/users [count] — recent users with usage\n"
    "/limit_up <userId> <n> — set that user's limit to n\n"
    "/limit_down <userId> <n> — set that user's limit to n (lower)\n"
    "/limit_add <userId> <n> — add n to that user's limit\n"
    "/limit_set <userId> <n> — same as limit_up\n"
    "/limit_all <n> — change the default limit for everyone\n"
    "/limit_default <n> — same as limit_all\n"
    "/broadcast <message> — send a message to all users\n"
    "/ban <userId>  /unban <userId>\n"
    "/pending — videos waiting to be auto-deleted\n"
    "/config — show current configuration\n"
    "/pause <message>  /resume — pause or resume delivery"
)
MSG_SEARCHING = "🔎 Finding your lecture…\nThis can take 20-90 seconds for big channels."
MSG_QUEUED = "🕒 Your request is in the queue. Position: {pos}"
MSG_DONE = "✅ Done! Your lecture is above."
MSG_AUTO_DELETE = (
    "⏳ This video will be deleted in {hours} hours.\n"
    "Please watch or save it before that."
)
MSG_LIMIT_TITLE = "⛔ Your daily limit is finished."
MSG_LIMIT_BODY = (
    "\n\nYou can watch {limit} videos per day.\n"
    "Used: {used}/{limit} • Resets at {resetTime} Indian time (in {reset})\n\n"
    "To increase your limit, contact @{contact}"
)
MSG_STATUS = (
    "📊 Your usage\n\n"
    "Limit: {limit} videos per day\n"
    "Used: {used} • Remaining: {remaining}\n"
    "Resets at: {resetTime} Indian time (in {reset})\n"
    "Total videos received: {total}\n\n"
    "To increase your limit, contact @{contact}"
)
MSG_NOT_FOUND = (
    "❌ Sorry, this video is not available.\n"
    "It may have been removed from the source channel, or the title did not "
    "match any video.\n\nPlease open it again from the website."
)
MSG_EXPIRED = (
    "⏰ This link has expired.\nPlease open the video again from the website "
    "and tap ▶ OPEN IN TELEGRAM."
)
MSG_INVALID_LINK = (
    "🔗 This link is not valid.\nPlease open the video from the website and tap "
    "▶ OPEN IN TELEGRAM."
)
MSG_NO_MEDIA = "❌ This lecture has no video file (it may be a YouTube class)."
MSG_RESTRICTED = (
    "🔒 The source channel restricts saving content, so this file cannot be "
    "downloaded with the current account.\nPlease ask the owner to allow saving, "
    "or make the bot's account an admin of that channel."
)
MSG_TOO_LARGE = (
    "📦 This file is larger than {limit} MB, which is above the Telegram bot "
    "upload limit. It cannot be delivered."
)
MSG_GENERIC_ERROR = (
    "⚠️ Something went wrong while preparing your video.\n"
    "Error: {error}\n\nPlease try again in a few minutes."
)
MSG_ALREADY_RUNNING = "⏳ This video is already being prepared. Please wait…"
MSG_BANNED = "⛔ Your access has been blocked. Contact @{contact} for help."

# ── 🛡️ ANTI-THEFT messages (v6) ────────────────────────────────────────────
MSG_LINK_OWNER = (
    "🔐 This link belongs to another account.\n"
    "Please open the lecture from the website with your own login and tap "
    "▶ OPEN IN TELEGRAM to get your own link."
)
MSG_LINK_USED = (
    "🔁 This link has already been used.\n"
    "Each link works only once. Open the lecture on the website again and tap "
    "▶ OPEN IN TELEGRAM for a fresh link."
)
MSG_GLOBAL_LIMIT = (
    "🚦 Delivery is temporarily full for today because of heavy traffic.\n"
    "Please try again after some time."
)

# ── 🔒 CHANNEL JOIN-GATE messages (v7) ─────────────────────────────────────
MSG_JOIN_GATE = (
    "🔒 Please join our channel first.\n\n"
    "Your lecture \"{title}\" is ready, but this service is only for our "
    "channel members.\n"
    "1. Tap \"Join our channel\" below.\n"
    "2. Come back and tap \"I have joined\" — I will verify and send the "
    "video here right away.\n\n"
    "Your link stays valid, so nothing is lost."
)
MSG_JOIN_GATE_SHORT = (
    "🔒 Please join our channel first, then tap \"I have joined\".\n"
    "Video delivery is only for channel members."
)
MSG_JOIN_VERIFIED = "✅ Verified — sending your lecture now…"
MSG_JOIN_STILL_NOT = (
    "⚠️ I could not confirm your membership yet.\n"
    "Open the channel, tap Join, then press \"I have joined\" again."
)
MSG_JOIN_RETRY = (
    "✅ Membership verified.\n"
    "Your earlier link has expired — please open the lecture on the website "
    "and tap ▶ OPEN IN TELEGRAM again."
)

#: Membership result kitni der cache rahe (sirf POSITIVE result cache hota hai)
JOIN_GATE_CACHE_SEC = 600
#: Pending "I have joined" entry kitni der valid rahe
JOIN_PENDING_TTL_SEC = 2 * 60 * 60


# ─────────────────────────────────────────────────────────────────────────────
# SMALL HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def log(text: str) -> None:
    print("[%s] %s" % (time.strftime("%H:%M:%S"), text), flush=True)


def human_bytes(size: float) -> str:
    size = float(size or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return ("%.1f %s" % (size, unit)) if unit != "B" else ("%d B" % size)
        size /= 1024.0
    return "%.1f GB" % size


def human_time(seconds: float) -> str:
    seconds = int(max(0, seconds))
    if seconds < 60:
        return "%ds" % seconds
    if seconds < 3600:
        return "%dm %02ds" % (seconds // 60, seconds % 60)
    return "%dh %02dm" % (seconds // 3600, (seconds % 3600) // 60)


def short_error(exc: BaseException) -> str:
    """User ko bhejne layak chhota, safe, English error."""
    name = type(exc).__name__
    text = strip_usernames(str(exc) or "")
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > 150:
        text = text[:150] + "…"
    return "%s: %s" % (name, text) if text else name


def load_dotenv_files() -> None:
    """Chhoti si .env loader (python-dotenv optional hai)."""
    candidates = [
        os.path.join(HERE, ".env"),
        os.path.join(REPO_ROOT, ".env.local"),
        os.path.join(REPO_ROOT, ".env"),
    ]
    try:
        from dotenv import load_dotenv  # type: ignore

        for path in candidates:
            if os.path.exists(path):
                load_dotenv(path, override=False)
        return
    except Exception:
        pass

    for path in candidates:
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    key, value = key.strip(), value.strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                        value = value[1:-1]
                    if key and key not in os.environ:
                        os.environ[key] = value
        except Exception:
            continue


# ─────────────────────────────────────────────────────────────────────────────
# PROGRESS REPORTER (throttled message edits — FloodWait safe)
# ─────────────────────────────────────────────────────────────────────────────
class ProgressReporter:
    def __init__(self, bot: Any, chat_id: int, status_message: Any, label: str, total: int = 0):
        self.bot = bot
        self.chat_id = chat_id
        self.status_message = status_message
        self.label = label
        self.total = int(total or 0)
        self.last_edit = 0.0
        self.last_pct = -1
        self.started = time.time()
        self.lock = asyncio.Lock()
        self.flood_until = 0.0

    async def update(self, current: float, total: Optional[float] = None) -> None:
        if total:
            self.total = int(total)
        now = time.time()
        pct = int((current / self.total) * 100) if self.total else -1
        if now < self.flood_until:
            return
        if now - self.last_edit < 1.5 and pct != 100 and pct - self.last_pct < 4:
            return
        self.last_edit = now
        self.last_pct = pct

        elapsed = max(0.5, now - self.started)
        speed = current / elapsed
        eta = (self.total - current) / speed if (self.total and speed > 0) else 0
        bar_len = 14
        filled = int(bar_len * (pct / 100)) if pct >= 0 else 0
        bar = "█" * filled + "░" * max(0, bar_len - filled)
        text = (
            "%s %s %s%%\n"
            "%s / %s • %s/s%s"
            % (
                self.label,
                bar,
                pct if pct >= 0 else "—",
                human_bytes(current),
                human_bytes(self.total) if self.total else "?",
                human_bytes(speed),
                (" • ETA " + human_time(eta)) if eta > 2 else "",
            )
        )
        async with self.lock:
            try:
                await self.bot.edit_message(self.chat_id, self.status_message.id, text)
            except Exception as exc:  # noqa: BLE001
                name = type(exc).__name__
                if "FloodWait" in name:
                    self.flood_until = time.time() + float(getattr(exc, "seconds", 30) or 30) + 1
                elif "MESSAGE_NOT_MODIFIED" in str(exc) or "MessageIdInvalid" in name:
                    pass
                else:
                    log("progress edit failed: %s" % short_error(exc))


# ─────────────────────────────────────────────────────────────────────────────
# DELIVERY BOT
# ─────────────────────────────────────────────────────────────────────────────
class _CallbackReplies:
    """CallbackQuery event par `reply()` shim.

    Delivery code `event.reply(...)` bulata hai; Telegram callback events par
    `respond()` hota hai — ye chhota adapter dono ko jod deta hai.
    """

    def __init__(self, event: Any) -> None:
        self._event = event

    def __getattr__(self, name: str) -> Any:
        return getattr(self._event, name)

    async def reply(self, *args: Any, **kwargs: Any) -> Any:
        return await self._event.respond(*args, **kwargs)


class DeliveryBot:
    def __init__(self, store: Store, creds: Dict[str, Any]) -> None:
        self.store = store
        self.creds = creds
        self.cfg: Dict[str, Any] = dict(DEFAULT_CONFIG)
        self.bot: Any = None
        self.user: Any = None
        self.started_at = time.time()
        self._download_slots = asyncio.Semaphore(int(os.environ.get("BOT_MAX_PARALLEL") or 2))
        self._per_user_locks: Dict[int, asyncio.Lock] = {}
        self._tasks: List[asyncio.Future] = []
        self._stopping = False
        self._admin_ids: set = set()
        self._queue_depth = 0
        # 🔒 join-gate: uid → (expiry_ts, True) sirf confirmed members cache
        self._join_cache: Dict[int, Tuple[float, bool]] = {}
        # 🔒 join-gate: uid → (request_id, ts) "I have joined" dabane par resume
        self._pending_join: Dict[int, Tuple[str, float]] = {}
        self.tmp_dir = os.environ.get("BOT_DOWNLOAD_DIR") or os.path.join(HERE, "downloads")
        os.makedirs(self.tmp_dir, exist_ok=True)

    # ── config helpers ─────────────────────────────────────────────────────
    def refresh_config(self) -> Dict[str, Any]:
        self.cfg = self.store.get_config()
        admins: set = set()
        raw = str(self.cfg.get("adminTgIds") or os.environ.get("ADMIN_TG_IDS") or "")
        for part in re.split(r"[,\s]+", raw):
            part = part.strip()
            if part.lstrip("-").isdigit():
                admins.add(int(part))
        # session owner (jiska account hai) hamesha admin
        owner = os.environ.get("OWNER_TG_ID")
        if owner and owner.strip().lstrip("-").isdigit():
            admins.add(int(owner.strip()))
        if self._me_id:
            admins.add(int(self._me_id))
        self._admin_ids = admins

        # 🔒 join-gate: .env se bhi set ho sakta hai (Admin Panel ki value jeetti
        #    hai; env sirf tab use hota hai jab panel me khaali chhoda ho).
        env_channel = str(os.environ.get("JOIN_GATE_CHANNEL") or "").strip()
        if env_channel and not str(self.cfg.get("joinGateChannel") or "").strip():
            self.cfg["joinGateChannel"] = env_channel
            self.cfg["joinGateEnabled"] = True
        env_invite = str(os.environ.get("JOIN_GATE_INVITE_URL") or "").strip()
        if env_invite and not str(self.cfg.get("joinGateInviteUrl") or "").strip():
            self.cfg["joinGateInviteUrl"] = env_invite
        return self.cfg

    _me_id: Optional[int] = None

    def _num(self, key: str, default: float) -> float:
        try:
            return float(self.cfg.get(key) if self.cfg.get(key) not in (None, "") else default)
        except (TypeError, ValueError):
            return default

    def _fmt(self, template: str, **extra: Any) -> str:
        data = {
            "app": os.environ.get("APP_NAME") or "Study helper Doc",
            "limit": int(self._num("dailyLimit", 20)),
            "resetTime": reset_time_label(self.cfg),
            "window": 24,  # legacy placeholder — quota ab IST day par reset hota hai
            "hours": _hours_text(self._num("autoDeleteHours", 2)),
            "contact": str(self.cfg.get("contactUsername") or "krishna84").lstrip("@"),
            "credit": str(self.cfg.get("creditUsername") or "krishna84").lstrip("@"),
        }
        data.update(extra)
        try:
            return template.format(**data)
        except Exception:
            return template

    def is_admin(self, uid: int) -> bool:
        return int(uid) in self._admin_ids

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def start(self) -> None:
        from telethon import TelegramClient
        from telethon.sessions import StringSession

        api_id = int(self.creds["apiId"])
        api_hash = str(self.creds["apiHash"])

        # 1) BOT client (users ko message/file bhejta hai)
        self.bot = TelegramClient(os.path.join(HERE, "shd_bot"), api_id, api_hash)
        await self.bot.start(bot_token=str(self.creds["botToken"]))
        bot_me = await self.bot.get_me()
        log("🤖 Bot connected: @%s (id=%s)" % (bot_me.username, bot_me.id))

        # 2) USER client (aapke groups/channels se file nikalta hai)
        session_string = str(self.creds.get("sessionString") or "")
        if session_string:
            self.user = TelegramClient(StringSession(session_string), api_id, api_hash)
        else:
            self.user = TelegramClient(os.path.join(HERE, "shd_user"), api_id, api_hash)
        await self.user.connect()
        if not await self.user.is_user_authorized():
            raise SystemExit(
                "\n❌ User session authorized nahi hai.\n"
                "   Bot ke liye ALAG session banayein:   python3 bot.py --login\n"
                "   (Website wali session string share karne se Telegram session\n"
                "    terminate ho sakta hai — alag login hi safe hai.)\n"
            )
        me = await self.user.get_me()
        self._me_id = int(me.id)
        log("👤 User session connected: %s (id=%s)" % (me.first_name, me.id))

        # 3) Config + apna username publish (website deep-link ke liye)
        self.refresh_config()
        if bot_me.username:
            self.store.save_config({"botUsername": str(bot_me.username)})
        if self._me_id and str(self._me_id) not in str(self.cfg.get("adminTgIds") or ""):
            self.store.save_config(
                {"adminTgIds": _merge_ids(self.cfg.get("adminTgIds"), self._me_id)}
            )
            self.refresh_config()
        self.store.set(
            "bot_state/heartbeat",
            {
                "at": int(time.time() * 1000),
                "bot": "@%s" % bot_me.username,
                "user": int(me.id),
                "backend": self.store.backend,
            },
        )

        self._register_handlers()
        self._tasks = [
            asyncio.ensure_future(self._sweeper_loop()),
            asyncio.ensure_future(self._task_poller_loop()),
            asyncio.ensure_future(self._heartbeat_loop()),
            asyncio.ensure_future(self._cleanup_loop()),
        ]
        gate_on = bool(self.cfg.get("joinGateEnabled")) and bool(
            str(self.cfg.get("joinGateChannel") or "").strip()
        )
        if bool(self.cfg.get("joinGateEnabled")) and not gate_on:
            log(
                "⚠️ join-gate ENABLED hai par joinGateChannel khaali hai — gate "
                "ignore ho raha hai (Admin Panel → Telegram Bot Delivery me "
                "channel @username bharein)."
            )
        log(
            "✅ Bot ready • mode=%s • limit=%s/24h • auto-delete=%sh • join-gate=%s • storage=%s"
            % (
                self.cfg.get("deliveryMode"),
                self.cfg.get("dailyLimit"),
                self.cfg.get("autoDeleteHours"),
                ("ON " + str(self.cfg.get("joinGateChannel"))) if gate_on else "off",
                self.store.backend,
            )
        )

    async def stop(self) -> None:
        self._stopping = True
        for task in self._tasks:
            task.cancel()
        for client in (self.user, self.bot):
            try:
                if client:
                    await client.disconnect()
            except Exception:
                pass

    # ── handlers ───────────────────────────────────────────────────────────
    def _register_handlers(self) -> None:
        from telethon import events

        @self.bot.on(events.CallbackQuery(data=re.compile(rb"^jg:(-?\d+)$")))
        async def on_join_gate(event: Any) -> None:  # noqa: D401
            """✅ 'I have joined' button → live verify → delivery resume."""
            uid = int(event.sender_id or 0)
            try:
                self.refresh_config()
                state = join_gate_state(self.cfg, await self._check_channel_member(uid))
                if state == "block":
                    await event.answer(self._fmt(MSG_JOIN_STILL_NOT), alert=True)
                    return

                pending = self._pending_join.pop(uid, None)
                if pending and (time.time() - float(pending[1])) > JOIN_PENDING_TTL_SEC:
                    pending = None
                if state == "pass":
                    try:
                        await event.answer(self._fmt(MSG_JOIN_VERIFIED), alert=False)
                    except Exception:  # noqa: BLE001
                        pass
                if pending and pending[0]:
                    self.store.log_event("join_gate_pass", uid=uid, requestId=pending[0])
                    await self.handle_delivery_request(
                        _CallbackReplies(event), uid, str(pending[0])
                    )
                    return
                await event.respond(self._fmt(MSG_JOIN_RETRY))
            except Exception as exc:  # noqa: BLE001
                log("join-gate callback crash: %s\n%s" % (short_error(exc), traceback.format_exc()))
                try:
                    await event.answer("⚠️ Please try again in a moment.", alert=True)
                except Exception:  # noqa: BLE001
                    pass

        @self.bot.on(events.NewMessage(incoming=True))
        async def on_message(event: Any) -> None:  # noqa: D401
            try:
                await self._route_message(event)
            except Exception as exc:  # noqa: BLE001
                log("handler crash: %s\n%s" % (short_error(exc), traceback.format_exc()))
                try:
                    await event.reply(self._fmt(MSG_GENERIC_ERROR, error=short_error(exc)))
                except Exception:
                    pass

    async def _route_message(self, event: Any) -> None:
        text = (event.raw_text or event.message or "").strip()
        uid = int(event.sender_id or 0)
        private = event.is_private

        self.store.register_user(
            uid,
            {
                "username": getattr(event.sender, "username", "") or "",
                "first_name": getattr(event.sender, "first_name", "") or "",
                "last_name": getattr(event.sender, "last_name", "") or "",
            },
        )
        self.refresh_config()

        if text.startswith("/"):
            parts = text.split(maxsplit=1)
            cmd = parts[0].split("@")[0].lower()
            arg = parts[1].strip() if len(parts) > 1 else ""
            await self._run_command(event, uid, cmd, arg, private)
            return

        if private:
            await event.reply(
                self._fmt(MSG_WELCOME) + "\n\n" + self._fmt(MSG_HELP)
            )

    async def _run_command(self, event: Any, uid: int, cmd: str, arg: str, private: bool) -> None:
        # ── user commands ──────────────────────────────────────────────────
        if cmd in ("/start", "/startapp"):
            if arg and re.fullmatch(r"[A-Za-z0-9_\-]{4,40}", arg):
                if not private:
                    await event.reply("Please use this link in a private chat with me.")
                    return
                await self.handle_delivery_request(event, uid, arg)
                return
            await event.reply(self._fmt(MSG_WELCOME) + "\n\n" + self._fmt(MSG_HELP))
            return

        if cmd == "/help":
            reply = self._fmt(MSG_HELP)
            if self.is_admin(uid):
                reply += self._fmt(MSG_HELP_ADMIN)
            await event.reply(reply)
            return

        if cmd in ("/status", "/mylimit", "/limit"):
            quota = self.store.quota_status(uid)
            await event.reply(
                self._fmt(
                    MSG_STATUS,
                    used=quota["used"],
                    remaining=quota["remaining"],
                    reset=human_time(quota["resetInSec"]) if quota["resetInSec"] else "—",
                    total=quota["totalVideos"],
                )
            )
            return

        if cmd == "/find":
            if not private:
                await event.reply("Please use /find in a private chat with me.")
                return
            await self.handle_manual_find(event, uid, arg)
            return

        # ── admin commands ─────────────────────────────────────────────────
        if not self.is_admin(uid):
            await event.reply("Unknown command. Send /help")
            return

        if cmd == "/stats":
            stats = self.store.stats()
            await event.reply(
                "📊 Bot stats\n\n"
                "Users: %d\n"
                "Videos sent (all time): %d\n"
                "Videos sent (today, IST): %d\n"
                "Pending auto-deletes: %d\n"
                "Storage backend: %s\n"
                "Bot: @%s\n"
                "Uptime: %s\n"
                "Delivery mode: %s\n"
                "Default limit: %d per day (resets %s IST)\n"
                "Auto-delete: %sh"
                % (
                    stats["totalUsers"],
                    stats["totalVideosSent"],
                    int(stats.get("videosToday") or stats.get("videosLast24h") or 0),
                    stats["pendingDeletions"],
                    stats["backend"],
                    stats["botUsername"] or "?",
                    human_time(time.time() - self.started_at),
                    self.cfg.get("deliveryMode"),
                    int(self._num("dailyLimit", 20)),
                    reset_time_label(self.cfg),
                    _hours_text(self._num("autoDeleteHours", 2)),
                )
            )
            return

        if cmd == "/users":
            limit = 20
            if arg.isdigit():
                limit = min(200, int(arg))
            users = self.store.list_users()
            rows: List[Tuple[int, Dict[str, Any]]] = []
            for key, val in users.items():
                if isinstance(val, dict):
                    try:
                        rows.append((int(key), val))
                    except (TypeError, ValueError):
                        continue
            rows.sort(key=lambda r: -int(r[1].get("lastSeen") or 0))
            if not rows:
                await event.reply("No users yet.")
                return
            lines = ["👥 Users (showing %d of %d)" % (min(limit, len(rows)), len(rows)), ""]
            for tg_uid, val in rows[:limit]:
                name = val.get("username") or val.get("firstName") or "—"
                quota = self.store.quota_status(tg_uid)
                flag = " 🚫" if val.get("banned") else ""
                lines.append(
                    "• `%d` @%s%s — used %d/%d • total %d"
                    % (tg_uid, name, flag, quota["used"], quota["limit"], quota["totalVideos"])
                )
            await event.reply("\n".join(lines))
            return

        if cmd in ("/limit_up", "/limit_set", "/limit_down", "/limit_add"):
            nums = re.findall(r"-?\d+", arg)
            if len(nums) < 2:
                await event.reply("Usage: %s <userId> <number>" % cmd)
                return
            target, value = int(nums[0]), abs(int(nums[1]))
            user = self.store.get_user(target)
            if not user:
                await event.reply("User %d not found in bot database yet." % target)
                return
            current = user.get("limit")
            if current is None:
                current = int(self._num("dailyLimit", 20))
            current = int(current)
            new_limit = current + value if cmd == "/limit_add" else value
            new_limit = max(0, min(100000, new_limit))
            user["limit"] = new_limit
            user["limitUpdatedAt"] = int(time.time() * 1000)
            self.store.save_user(target, user)
            self.store.log_event("limit_changed", uid=target, limit=new_limit, by=uid, cmd=cmd)
            await event.reply("✅ Daily limit for `%d` is now %d videos / 24h." % (target, new_limit))
            return

        if cmd in ("/limit_all", "/limit_default"):
            nums = re.findall(r"\d+", arg)
            if not nums:
                await event.reply("Usage: %s <number>" % cmd)
                return
            value = max(0, min(100000, int(nums[0])))
            self.store.save_config({"dailyLimit": value})
            self.refresh_config()
            self.store.log_event("default_limit_changed", limit=value, by=uid)
            await event.reply("✅ Default daily limit is now %d videos / 24h for all users." % value)
            return

        if cmd == "/broadcast":
            if not arg:
                await event.reply("Usage: /broadcast <message>")
                return
            sent, failed = await self._broadcast(strip_usernames(arg) or arg, exclude=uid)
            await event.reply("📣 Broadcast finished.\nSent: %d\nFailed: %d" % (sent, failed))
            return

        if cmd in ("/ban", "/unban"):
            nums = re.findall(r"-?\d+", arg)
            if not nums:
                await event.reply("Usage: %s <userId>" % cmd)
                return
            target = int(nums[0])
            user = self.store.get_user(target)
            user["banned"] = cmd == "/ban"
            self.store.save_user(target, user)
            self.store.log_event("ban" if cmd == "/ban" else "unban", uid=target, by=uid)
            await event.reply("✅ %d %s." % (target, "blocked" if cmd == "/ban" else "unblocked"))
            return

        if cmd == "/pending":
            rows = self.store.pending_deletions()
            if not rows:
                await event.reply("No pending auto-deletes.")
                return
            lines = ["⏳ Pending auto-deletes: %d" % len(rows), ""]
            for row in rows[:25]:
                due = max(0, (int(row.get("deleteAt") or 0) / 1000.0) - time.time())
                lines.append("• user `%s` msg `%s` in %s" % (row.get("uid"), row.get("messageId"), human_time(due)))
            await event.reply("\n".join(lines))
            return

        if cmd == "/config":
            lines = ["⚙️ Current configuration", ""]
            for key in sorted(self.cfg.keys()):
                lines.append("• %s = %s" % (key, self.cfg[key]))
            await event.reply("\n".join(lines))
            return

        if cmd == "/pause":
            self.store.save_config({"paused": True, "pauseMessage": arg or DEFAULT_CONFIG["pauseMessage"]})
            self.refresh_config()
            await event.reply("⏸ Delivery paused.")
            return

        if cmd == "/resume":
            self.store.save_config({"paused": False})
            self.refresh_config()
            await event.reply("▶️ Delivery resumed.")
            return

        if cmd == "/ping":
            await event.reply("🏓 pong • uptime %s • storage %s" % (human_time(time.time() - self.started_at), self.store.backend))
            return

        await event.reply("Unknown command. Send /help")

    # ── broadcast ──────────────────────────────────────────────────────────
    async def _broadcast(self, text: str, exclude: int = 0) -> Tuple[int, int]:
        from telethon import errors

        sent = failed = 0
        users = self.store.list_users()
        for key in users.keys():
            try:
                target = int(key)
            except (TypeError, ValueError):
                continue
            if target == exclude:
                continue
            try:
                await self.bot.send_message(target, text)
                sent += 1
                await asyncio.sleep(0.06)
            except errors.FloodWaitError as exc:
                await asyncio.sleep(min(60, int(getattr(exc, "seconds", 5) or 5)))
                failed += 1
            except Exception:
                failed += 1
        return sent, failed

    # ── manual /find ───────────────────────────────────────────────────────
    async def handle_manual_find(self, event: Any, uid: int, arg: str) -> None:
        if not arg or "|" not in arg:
            await event.reply(
                "Usage: /find <course name> | <video title>\n"
                "Example: /find 12th मंजिल बैच 2027 | Solid State Part 1"
            )
            return
        course, title = [p.strip() for p in arg.split("|", 1)]
        request = {
            "title": title,
            "topic": "",
            "courseName": course,
            "fileSize": 0,
            "chatId": "",
            "messageId": 0,
            "manual": True,
        }
        await self._deliver(event, uid, request, request_id="find")

    # ── deep-link delivery (website → bot) ─────────────────────────────────
    async def handle_delivery_request(self, event: Any, uid: int, request_id: str) -> None:
        request = self.store.get_request(request_id)
        if not request:
            await event.reply(self._fmt(MSG_EXPIRED))
            self.store.log_event("request_missing", uid=uid, requestId=request_id)
            return
        request["requestId"] = request_id
        await self._deliver(event, uid, request, request_id=request_id)

    # ── 🔒 channel join-gate ───────────────────────────────────────────────
    async def _check_channel_member(self, uid: int) -> Optional[bool]:
        """True/False = confirmed, None = check possible nahi (fail-open).

        Pehle BOT client try hota hai (bot ko channel me ADMIN hona chahiye),
        fail hone par USER session (jo khud channel ka member hota hai).
        """
        channel = str(self.cfg.get("joinGateChannel") or "").strip()
        if not channel or not uid:
            return None

        now = time.time()
        cached = self._join_cache.get(int(uid))
        if cached and cached[0] > now and cached[1]:
            return True

        target: Any = channel
        if channel.lstrip("-").isdigit():
            try:
                target = int(channel)
            except ValueError:
                target = channel

        result: Optional[bool] = None
        for client in (self.bot, self.user):
            if client is None:
                continue
            try:
                from telethon import functions

                res = await client(
                    functions.channels.GetParticipantRequest(
                        channel=target, participant=int(uid)
                    )
                )
                part = getattr(res, "participant", None)
                # Banned/kicked = member nahi; baaki sab (creator/admin/member) = member
                result = type(part).__name__ != "ChannelParticipantBanned"
                break
            except Exception as exc:  # noqa: BLE001
                name = type(exc).__name__
                if name in (
                    "UserNotParticipantError",
                    "UserBannedInChannelError",
                    "ChannelParticipantNotFound",
                ):
                    result = False
                    break
                log(
                    "join-gate: membership check failed (%s): %s"
                    % (name, short_error(exc))
                )
                continue

        if result is True:
            self._join_cache[int(uid)] = (now + JOIN_GATE_CACHE_SEC, True)
        elif result is None:
            self.store.log_event("join_gate_check_failed", uid=int(uid))
        return result

    async def _send_join_gate(
        self, event: Any, uid: int, request: Dict[str, Any], request_id: str
    ) -> None:
        """Join button + 'I have joined' button bhejo aur delivery rok do."""
        from telethon import Button

        title = clean_text(str(request.get("title") or "your lecture"))[:120]
        invite = _join_invite_url(self.cfg)
        row: List[Any] = []
        if invite:
            row.append(Button.url("📢 Join our channel", invite))
            text = self._fmt(MSG_JOIN_GATE, title=title)
        else:
            text = self._fmt(MSG_JOIN_GATE_SHORT)
        row.append(Button.inline("✅ I have joined", b"jg:%d" % int(uid)))
        try:
            await event.reply(text, buttons=[row], link_preview=False)
        except TypeError:
            # kuch event shim par link_preview support nahi hota
            await event.reply(text, buttons=[row])

        if request_id and request_id != "find":
            self._pending_join[int(uid)] = (str(request_id), time.time())
        self.store.log_event("join_gate_block", uid=int(uid), requestId=request_id)
        log("🔒 join-gate blocked uid=%s (channel=%s)" % (uid, self.cfg.get("joinGateChannel")))

    async def _deliver(self, event: Any, uid: int, request: Dict[str, Any], request_id: str) -> None:
        self.refresh_config()

        user_row = self.store.get_user(uid)
        if user_row.get("banned"):
            await event.reply(self._fmt(MSG_BANNED))
            return

        if self.cfg.get("paused"):
            await event.reply(str(self.cfg.get("pauseMessage") or DEFAULT_CONFIG["pauseMessage"]))
            return

        if request.get("youtubeUrl") and not request.get("chatId"):
            await event.reply(self._fmt(MSG_NO_MEDIA))
            return

        # 🔒 CHANNEL JOIN-GATE: member nahi hai to link consume hi nahi hota
        #    (quota bhi nahi katti, binding bhi nahi hoti).
        if bool(self.cfg.get("joinGateEnabled")) and str(
            self.cfg.get("joinGateChannel") or ""
        ).strip():
            if join_gate_state(self.cfg, await self._check_channel_member(uid)) == "block":
                await self._send_join_gate(event, uid, request, request_id)
                return

        # 🛡️ ANTI-THEFT GATE: global breaker → single-use → account binding
        gate_reason = ""
        if request_id and request_id != "find":
            try:
                _st = self.store.stats() or {}
                videos_24h = int(_st.get("videosToday") or _st.get("videosLast24h") or 0)
            except Exception:  # noqa: BLE001
                videos_24h = 0
            allowed, gate_reason = request_gate(request, uid, self.cfg, videos_24h)
            if not allowed:
                msg = {
                    "global_limit": MSG_GLOBAL_LIMIT,
                    "used": MSG_LINK_USED,
                    "owner": MSG_LINK_OWNER,
                }.get(gate_reason, MSG_LINK_USED)
                await event.reply(self._fmt(msg))
                self.store.log_event(
                    "blocked_%s" % gate_reason, uid=uid, requestId=request_id
                )
                return

            # link ko is Telegram account par BIND kar do (pehli baar)
            if not int(request.get("boundTgUid") or 0):
                request["boundTgUid"] = int(uid)
                try:
                    self.store.set_request(
                        request_id,
                        {**_serializable_request(request), "boundTgUid": int(uid)},
                    )
                except Exception:  # noqa: BLE001
                    pass

        quota = self.store.quota_status(uid)
        if quota["remaining"] <= 0:
            await event.reply(
                MSG_LIMIT_TITLE
                + self._fmt(
                    MSG_LIMIT_BODY,
                    used=quota["used"],
                    reset=human_time(quota["resetInSec"]) or "a few minutes",
                )
            )
            self.store.log_event("limit_reached", uid=uid, requestId=request_id)
            return

        lock = self._per_user_locks.setdefault(uid, asyncio.Lock())
        if lock.locked():
            await event.reply(self._fmt(MSG_ALREADY_RUNNING))
            return

        async with lock:
            status = await event.reply(self._fmt(MSG_SEARCHING))
            try:
                if self._queue_depth >= int(self._download_slots._value or 1):  # type: ignore[attr-defined]
                    await self.bot.edit_message(
                        uid, status.id, self._fmt(MSG_QUEUED, pos=self._queue_depth)
                    )
                self._queue_depth += 1
                try:
                    async with self._download_slots:
                        await self._run_delivery(uid, status, request, request_id)
                finally:
                    self._queue_depth = max(0, self._queue_depth - 1)
            except Exception as exc:  # noqa: BLE001
                log("delivery crash: %s\n%s" % (short_error(exc), traceback.format_exc()))
                self.store.log_event("delivery_error", uid=uid, requestId=request_id, error=short_error(exc))
                try:
                    await self.bot.edit_message(
                        uid, status.id, self._fmt(MSG_GENERIC_ERROR, error=short_error(exc))
                    )
                except Exception:
                    pass

    async def _run_delivery(self, uid: int, status: Any, request: Dict[str, Any], request_id: str) -> None:
        title = clean_text(str(request.get("title") or "Lecture"))
        topic = _topic_path(request)
        course = clean_text(str(request.get("courseName") or request.get("course") or ""))

        candidate = await self.find_message(request)
        if not candidate:
            await self.bot.edit_message(uid, status.id, self._fmt(MSG_NOT_FOUND))
            self.store.log_event(
                "not_found",
                uid=uid,
                requestId=request_id,
                title=title,
                course=course,
            )
            return

        message = candidate.get("message")
        size = int(candidate.get("file_size") or 0)
        max_mb = float(self._num("maxUploadMb", 2000))
        if size and size > max_mb * 1024 * 1024:
            await self.bot.edit_message(uid, status.id, self._fmt(MSG_TOO_LARGE, limit=int(max_mb)))
            self.store.log_event("too_large", uid=uid, size=size)
            return

        chat_title = str(candidate.get("chat_title") or "")
        source_caption = str(candidate.get("caption") or "")
        noforwards = bool(candidate.get("noforwards"))
        # 🎬 mode ab PER-SOURCE decide hota hai (public → forward, private → clean)
        configured = str(self.cfg.get("deliveryMode") or "auto").lower()
        mode = delivery_mode_for(self.cfg, candidate)
        if mode == "clean" and configured in ("auto", "forward"):
            log(
                "delivery: clean mode (source %s)"
                % (
                    "restricted/noforwards" if noforwards
                    else "private chat" if not candidate.get("chat_public")
                    else "caption has @handle"
                )
            )

        matched = candidate.get("parsed") or parse_caption(source_caption, candidate.get("file_name", ""))
        caption = build_delivery_caption(
            title=matched.get("title") or title,
            topic=topic or matched.get("topic") or "",
            course=course or matched.get("course") or chat_title,
            credit_username=str(self.cfg.get("creditUsername") or "krishna84"),
        )

        self.store.log_event(
            "matched",
            uid=uid,
            requestId=request_id,
            title=title,
            course=course,
            chatId=str(candidate.get("chat_id")),
            messageId=int(candidate.get("message_id") or 0),
            score=float(candidate.get("score") or 0),
            reason=str(candidate.get("reason") or ""),
            mode=mode,
        )

        sent_message = None
        tmp_path: Optional[str] = None
        try:
            if mode == "forward":
                await self.bot.edit_message(
                    uid, status.id, "📤 Sending your lecture… (forward mode)"
                )
                sent_message = await self.user.forward_messages(uid, message)
                if isinstance(sent_message, list):
                    sent_message = sent_message[0] if sent_message else None
            else:
                # ── CLEAN MODE: download (user session) → upload (bot) ────────
                file_name = safe_display_name(
                    candidate.get("file_name") or matched.get("title") or title
                )
                tmp_path = os.path.join(self.tmp_dir, "%d_%d_%s" % (uid, int(time.time()), file_name))

                reporter = ProgressReporter(self.bot, uid, status, "⬇️ Downloading…", size)
                await self.user.download_media(
                    message,
                    file=tmp_path,
                    progress_callback=lambda cur, tot: asyncio.ensure_future(reporter.update(cur, tot)),
                )
                if not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
                    raise RuntimeError("download produced an empty file")

                actual_size = os.path.getsize(tmp_path)
                await self.bot.edit_message(
                    uid,
                    status.id,
                    "⬇️ Downloaded %s\n⬆️ Preparing to upload…" % human_bytes(actual_size),
                )

                up_reporter = ProgressReporter(self.bot, uid, status, "⬆️ Uploading…", actual_size)
                sent_message = await self.bot.send_file(
                    uid,
                    tmp_path,
                    caption=caption,
                    supports_streaming=True,
                    force_document=False,
                    file_name=file_name,
                    attributes=_video_attributes(message, file_name),
                    progress_callback=lambda cur, tot: asyncio.ensure_future(up_reporter.update(cur, tot)),
                )

            if sent_message is None:
                raise RuntimeError("delivery failed (no message returned)")

            message_id = sent_message.id if not isinstance(sent_message, list) else sent_message[0].id

            hours = float(self._num("autoDeleteHours", 2))
            delete_at = int((time.time() + hours * 3600) * 1000)
            self.store.add_deletion(uid, int(message_id), delete_at)

            try:
                await self.bot.delete_messages(uid, [status.id])
            except Exception:
                try:
                    await self.bot.edit_message(uid, status.id, self._fmt(MSG_DONE))
                except Exception:
                    pass

            await self.bot.send_message(uid, self._fmt(MSG_AUTO_DELETE))
            quota = self.store.consume_quota(uid)

            # request record par delivery mark (website admin panel ko dikhe)
            # 🛡️ usedCount badhao — reuseLimit pahunchte hi link MAR jata hai
            if request_id and request_id != "find":
                try:
                    reuse_limit = max(1, int(self.cfg.get("requestReuseLimit") or 1))
                except (TypeError, ValueError):
                    reuse_limit = 1
                try:
                    used_count = int(request.get("usedCount") or 0) + 1
                except (TypeError, ValueError):
                    used_count = 1

                if used_count >= reuse_limit:
                    # single-use: record hata do → link dobara kaam nahi karega
                    self.store.delete_request(request_id)
                else:
                    self.store.set_request(
                        request_id,
                        {
                            **_serializable_request(request),
                            "deliveredTo": int(uid),
                            "deliveredAt": int(time.time() * 1000),
                            "deleteAt": delete_at,
                            "deliveryMode": mode,
                            "usedCount": used_count,
                            "usedAt": int(time.time() * 1000),
                        },
                    )

            self.store.log_event(
                "delivered",
                uid=uid,
                requestId=request_id,
                title=title,
                size=size,
                mode=mode,
                remaining=quota["remaining"],
            )
            log(
                "✅ delivered to %s • %s • %s • score=%s • mode=%s"
                % (uid, title[:40], human_bytes(size), candidate.get("score"), mode)
            )

            if quota["remaining"] <= 0:
                await self.bot.send_message(
                    uid,
                    MSG_LIMIT_TITLE
                    + self._fmt(MSG_LIMIT_BODY, used=quota["used"], reset=human_time(quota["resetInSec"]) or "a few minutes"),
                )
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

    # ── SEARCH ENGINE ──────────────────────────────────────────────────────
    async def find_message(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """1) direct record → 2) same-chat search → 3) global search → 4) deep scan."""
        from telethon import errors
        from telethon.tl.types import InputMessagesFilterVideo

        title = str(request.get("title") or "")
        course = str(request.get("courseName") or request.get("course") or "")
        topic = str(request.get("topic") or "")
        deadline = time.time() + float(os.environ.get("BOT_SEARCH_BUDGET_SEC") or 120)

        # ── 1) DIRECT (website record me chatId + messageId hota hai) ──────
        chat_id = str(request.get("chatId") or "").strip()
        message_id = int(request.get("messageId") or 0)
        direct_entity = None
        if chat_id and message_id:
            try:
                direct_entity = await self._resolve_chat(chat_id)
                message = await self.user.get_messages(direct_entity, ids=message_id)
                if message and _has_media(message):
                    cand = _candidate_from_message(message, score=100.0, reason="direct (website record)")
                    log("🎯 direct hit: chat=%s msg=%s" % (chat_id, message_id))
                    return cand
                log("direct record had no media (chat=%s msg=%s)" % (chat_id, message_id))
            except Exception as exc:  # noqa: BLE001
                log("direct lookup failed: %s" % short_error(exc))

        # ── dialogs ko course-match ke hisaab se sort karo ─────────────────
        try:
            dialogs = await self.user.get_dialogs(limit=int(self._num("maxDialogs", 60)))
        except Exception as exc:  # noqa: BLE001
            log("get_dialogs failed: %s" % short_error(exc))
            return None

        ranked: List[Tuple[float, Any]] = []
        for dialog in dialogs:
            entity = getattr(dialog, "entity", None)
            if entity is None or getattr(dialog, "is_user", False):
                continue
            name = getattr(dialog, "title", "") or getattr(entity, "title", "") or ""
            score = course_match_score(course, name) if course else 0.5
            if direct_entity is not None and _same_entity(entity, direct_entity):
                score += 10.0  # website wala chat sabse pehle
            ranked.append((score, entity))
        ranked.sort(key=lambda item: -item[0])

        query = search_query(title, topic)

        # ── 2/3) SERVER-SIDE SEARCH (har relevant chat me) ─────────────────
        candidates: List[Dict[str, Any]] = []
        for score_bias, entity in ranked:
            if time.time() > deadline:
                log("search budget exhausted (server search phase)")
                break
            try:
                async for message in self.user.iter_messages(
                    entity,
                    limit=int(self._num("maxMessagesPerChat", 40)),
                    search=query or None,
                    filter=InputMessagesFilterVideo,
                ):
                    if not _has_media(message):
                        continue
                    cand = _candidate_from_message(message)
                    cand = self._score(candidate_request(request), cand)
                    if float(cand.get("score") or 0) >= MATCH_THRESHOLD:
                        candidates.append(cand)
            except errors.ChatAdminRequiredError:
                log("admin required in one chat — skipped")
            except Exception as exc:  # noqa: BLE001
                log("search failed in a chat: %s" % short_error(exc))
            if candidates:
                best = _best(candidates)
                if best and float(best.get("score") or 0) >= 88:
                    log("🎯 server search hit (score %s)" % best.get("score"))
                    return best

        if candidates:
            best = _best(candidates)
            if best:
                log("🎯 server search best (score %s)" % best.get("score"))
                return best

        # ── 4) DEEP SCAN (bina server-search ke captions padho) ────────────
        if not self.cfg.get("deepScan", True):
            return None
        log("deep scan starting (server search found nothing good)…")
        for score_bias, entity in ranked[:12]:
            if time.time() > deadline:
                log("search budget exhausted (deep scan)")
                break
            try:
                async for message in self.user.iter_messages(
                    entity,
                    limit=int(self._num("maxMessagesPerChat", 40)) * 2,
                    filter=InputMessagesFilterVideo,
                ):
                    if not _has_media(message):
                        continue
                    cand = _candidate_from_message(message)
                    cand = self._score(candidate_request(request), cand)
                    if float(cand.get("score") or 0) >= MATCH_THRESHOLD:
                        candidates.append(cand)
            except Exception as exc:  # noqa: BLE001
                log("deep scan failed in a chat: %s" % short_error(exc))

        best = _best(candidates)
        if best:
            log("🎯 deep scan hit (score %s)" % best.get("score"))
        return best

    def _score(self, request: Dict[str, Any], candidate: Dict[str, Any]) -> Dict[str, Any]:
        result = score_candidate(request, candidate)
        candidate = dict(candidate)
        candidate.update(result)
        return candidate

    async def _resolve_chat(self, chat_id: str) -> Any:
        text = str(chat_id).strip()
        if text.startswith("@"):
            return await self.user.get_entity(text)
        try:
            numeric = int(text)
        except ValueError:
            return await self.user.get_entity(text)
        # -100xxxx ya xxxx dono chalega
        try:
            return await self.user.get_entity(numeric)
        except Exception:
            if not str(numeric).startswith("-100"):
                try:
                    return await self.user.get_entity(int("-100%s" % abs(numeric)))
                except Exception:
                    pass
            raise

    # ── background loops ───────────────────────────────────────────────────
    async def _sweeper_loop(self) -> None:
        """2 ghante baad video auto-delete (restart-safe)."""
        while not self._stopping:
            try:
                due = self.store.due_deletions()
                for row in due:
                    try:
                        await self.bot.delete_messages(int(row["uid"]), [int(row["messageId"])])
                        log("🗑 auto-deleted msg %s of user %s" % (row.get("messageId"), row.get("uid")))
                    except Exception as exc:  # noqa: BLE001
                        log("auto-delete failed: %s" % short_error(exc))
                    finally:
                        self.store.remove_deletion(str(row.get("_key")))
            except Exception as exc:  # noqa: BLE001
                log("sweeper error: %s" % short_error(exc))
            await asyncio.sleep(30)

    async def _task_poller_loop(self) -> None:
        """Admin panel (website) se aaye tasks: broadcast / limit / config."""
        while not self._stopping:
            try:
                for task in self.store.claim_tasks():
                    key = str(task.get("_key"))
                    task_type = str(task.get("type") or "")
                    payload = task.get("payload") or {}
                    try:
                        if task_type == "broadcast":
                            text = str(payload.get("message") or "").strip()
                            if text:
                                sent, failed = await self._broadcast(text)
                                self.store.mark_task(key, "done", "sent=%d failed=%d" % (sent, failed))
                            else:
                                self.store.mark_task(key, "error", "empty message")
                        elif task_type == "set_limit":
                            target = int(payload.get("userId") or 0)
                            value = int(payload.get("limit") or 0)
                            if target:
                                user = self.store.get_user(target)
                                user["limit"] = max(0, value)
                                self.store.save_user(target, user)
                                self.store.mark_task(key, "done", "limit=%d" % value)
                            else:
                                self.store.save_config({"dailyLimit": max(0, value)})
                                self.store.mark_task(key, "done", "default limit=%d" % value)
                        elif task_type == "set_config":
                            if isinstance(payload, dict) and payload:
                                self.store.save_config(payload)
                                self.refresh_config()
                            self.store.mark_task(key, "done", "config updated")
                        else:
                            self.store.mark_task(key, "error", "unknown task type: %s" % task_type)
                    except Exception as exc:  # noqa: BLE001
                        self.store.mark_task(key, "error", short_error(exc))
                        log("task %s failed: %s" % (task_type, short_error(exc)))
            except Exception as exc:  # noqa: BLE001
                log("task poller error: %s" % short_error(exc))
            await asyncio.sleep(10)

    async def _heartbeat_loop(self) -> None:
        while not self._stopping:
            try:
                self.store.set(
                    "bot_state/heartbeat",
                    {
                        "at": int(time.time() * 1000),
                        "backend": self.store.backend,
                        "uptimeSec": int(time.time() - self.started_at),
                        "mode": self.cfg.get("deliveryMode"),
                    },
                )
            except Exception:
                pass
            await asyncio.sleep(60)

    async def _cleanup_loop(self) -> None:
        """Purane/expired request records + events saaf karta rehta hai."""
        while not self._stopping:
            try:
                ttl_hours = float(self._num("requestTtlHours", 168))
                now = time.time()
                removed = 0
                for key, val in self.store.list_requests().items():
                    if not isinstance(val, dict):
                        continue
                    created = float(val.get("createdAt") or 0) / 1000.0
                    if created and now - created > ttl_hours * 3600:
                        self.store.delete_request(str(key))
                        removed += 1
                if removed:
                    log("🧹 cleaned %d expired request record(s)" % removed)
            except Exception as exc:  # noqa: BLE001
                log("cleanup error: %s" % short_error(exc))
            await asyncio.sleep(3600)


# ─────────────────────────────────────────────────────────────────────────────
# TELETHON-SIDE HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def _hours_text(hours: float) -> str:
    hours = float(hours or 0)
    if hours <= 0:
        return "0"
    if abs(hours - round(hours)) < 0.01:
        return str(int(round(hours)))
    return ("%.1f" % hours).rstrip("0").rstrip(".")


def _merge_ids(existing: Any, new_id: int) -> str:
    ids: List[str] = []
    for part in re.split(r"[,\s]+", str(existing or "")):
        if part.strip():
            ids.append(part.strip())
    if str(new_id) not in ids:
        ids.append(str(new_id))
    return ",".join(ids)


def _has_media(message: Any) -> bool:
    try:
        return bool(getattr(message, "video", None) or (
            getattr(message, "document", None) and not getattr(message, "audio", None)
        ))
    except Exception:
        return False


def _same_entity(a: Any, b: Any) -> bool:
    try:
        return int(getattr(a, "id", 0)) == int(getattr(b, "id", 0))
    except Exception:
        return False


def _media_size(message: Any) -> int:
    for attr in ("video", "document"):
        media = getattr(message, attr, None)
        size = getattr(media, "size", None)
        if size:
            try:
                return int(size)
            except (TypeError, ValueError):
                continue
    try:
        if message.media and getattr(message.media, "size", None):
            return int(message.media.size)
    except Exception:
        pass
    return 0


def _media_duration(message: Any) -> int:
    video = getattr(message, "video", None)
    duration = getattr(video, "duration", None)
    try:
        return int(duration or 0)
    except (TypeError, ValueError):
        return 0


def _media_name(message: Any) -> str:
    try:
        name = getattr(getattr(message, "file", None), "name", None)
        if name:
            return str(name)
    except Exception:
        pass
    for attr in ("document", "video"):
        media = getattr(message, attr, None)
        for attribute in getattr(media, "attributes", []) or []:
            file_name = getattr(attribute, "file_name", None)
            if file_name:
                return str(file_name)
    return ""


def delivery_mode_for(cfg: Dict[str, Any], candidate: Dict[str, Any]) -> str:
    """🎬 Is video ke liye kaunsa mode: "forward" ya "clean" (download+upload).

    User rule:
      • Video PUBLIC group/channel me hai aur forwarding allowed hai → **forward**
        (fast, kam data, original quality).
      • Video PRIVATE channel me hai  → **clean** (source ki pehchaan chhupani hai).
      • Forwarding allowed nahi (`noforwards`) → **clean** (Telegram rok deta hai).
      • Caption me kisi aur ka @handle hai → **clean** (handle leak nahi hona chahiye).

    Admin override: cfg.deliveryMode = "clean" (hamesha re-upload) ya
    "forward" (jab bhi possible ho forward).
    """
    mode = str((cfg or {}).get("deliveryMode") or "auto").strip().lower()
    if bool(candidate.get("noforwards")):
        return "clean"
    if mode == "clean":
        return "clean"
    if mode == "forward":
        return "forward"
    if not bool(candidate.get("chat_public")):
        return "clean"
    if "@" in str(candidate.get("caption") or ""):
        return "clean"
    return "forward"


def _noforwards(message: Any) -> bool:
    chat = getattr(message, "chat", None) or getattr(getattr(message, "peer_id", None), "chat", None)
    for source in (chat, getattr(message, "chat", None)):
        flag = getattr(source, "noforwards", None)
        if flag is not None:
            return bool(flag)
    return False


def _chat_title(message: Any) -> str:
    chat = getattr(message, "chat", None)
    for attr in ("title", "username"):
        value = getattr(chat, attr, None)
        if value:
            return str(value)
    return ""


def _candidate_from_message(message: Any, score: float = 0.0, reason: str = "") -> Dict[str, Any]:
    caption = str(getattr(message, "message", "") or "")
    file_name = _media_name(message)
    return {
        "message": message,
        "caption": caption,
        "file_name": file_name,
        "file_size": _media_size(message),
        "duration": _media_duration(message),
        "chat_id": getattr(getattr(message, "peer_id", None), "channel_id", None)
        or getattr(getattr(message, "chat", None), "id", 0),
        "chat_title": _chat_title(message),
        "message_id": int(getattr(message, "id", 0) or 0),
        "noforwards": _noforwards(message),
        # PUBLIC channel/group (username hai) → direct forward allowed
        "chat_public": bool(getattr(getattr(message, "chat", None), "username", "") or ""),
        "score": score,
        "reason": reason,
        "parsed": parse_caption(caption, file_name),
    }


def candidate_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """score_candidate() ke liye website request → matcher shape."""
    return {
        "title": request.get("title") or "",
        "topic": _topic_path(request),
        "courseName": request.get("courseName") or request.get("course") or "",
        "fileSize": int(request.get("fileSize") or 0),
        "part": request.get("part"),
    }


def _topic_path(request: Dict[str, Any]) -> str:
    """Folder-wise topic: "Chemistry > Solid State > Part 1" style."""
    parts: List[str] = []
    folder_path = request.get("folderPath")
    if isinstance(folder_path, list):
        parts.extend([clean_text(str(p)) for p in folder_path if p])
    elif isinstance(folder_path, str) and folder_path:
        parts.extend([clean_text(p) for p in folder_path.split(">") if p.strip()])
    topic = clean_text(str(request.get("topic") or ""))
    if topic and topic not in parts:
        parts.append(topic)
    parts = [p for p in parts if p]
    # dedupe (same folder name 2 baar na aaye)
    seen: List[str] = []
    for part in parts:
        if not any(part.lower() == s.lower() for s in seen):
            seen.append(part)
    return " › ".join(seen[:4])


def _best(candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    deduped = dedupe_candidates(candidates)
    for cand in deduped:
        if float(cand.get("score") or 0) >= MATCH_THRESHOLD:
            return cand
    return None


def _video_attributes(message: Any, file_name: str) -> List[Any]:
    """Duration/size attributes taaki Telegram me video sahi dikhe."""
    try:
        from telethon.tl.types import DocumentAttributeVideo

        duration = _media_duration(message)
        if duration <= 0:
            return []
        return [DocumentAttributeVideo(duration=duration, w=0, h=0, supports_streaming=True)]
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────────────────────
# 🛡️ ANTI-THEFT GATE (v6)
# ----------------------------------------------------------------------------
# Website par daily limit thi, par koi banda 15 deep-link bana kar unhe alag-alag
# Telegram accounts me khol sakta tha → poora course chori. Ab:
#   1) GLOBAL circuit breaker : poori site par 24h me N video se zyada nahi
#   2) SINGLE-USE link        : usedCount >= requestReuseLimit → mana
#   3) ACCOUNT BINDING        : jo pehla Telegram user link kholta hai, link
#                               usi ka; dusre user ko "belongs to another account"
# Pure function hai taaki offline self-test me verify ho sake.
# ─────────────────────────────────────────────────────────────────────────────
def join_gate_state(cfg: Dict[str, Any], is_member: Optional[bool]) -> str:
    """🔒 Join-gate ka faisla (pure function — offline test ho sakti hai).

    Returns:
      "off"     → gate band hai ya channel configured nahi (delivery chalu)
      "pass"    → member confirmed (delivery chalu)
      "block"   → member NAHI hai (delivery roko, join button dikhao)
      "unknown" → check fail hua (bot admin nahi / channel private) → FAIL-OPEN,
                  delivery chalu rahegi taaki galat config ki saza student ko
                  na mile; owner ko logs me warning dikhti hai.
    """
    if not bool(cfg.get("joinGateEnabled")):
        return "off"
    if not str(cfg.get("joinGateChannel") or "").strip():
        return "off"
    if is_member is None:
        return "unknown"
    return "pass" if is_member else "block"


def _join_invite_url(cfg: Dict[str, Any]) -> str:
    """Button ke liye invite link — configured ho to wahi, warna t.me/<user>."""
    invite = str(cfg.get("joinGateInviteUrl") or "").strip()
    if invite:
        return invite
    channel = str(cfg.get("joinGateChannel") or "").strip()
    if not channel or channel.lstrip("-").isdigit():
        return ""
    return "https://t.me/" + channel.lstrip("@")


def request_gate(
    request: Dict[str, Any],
    uid: int,
    cfg: Dict[str, Any],
    videos_last_24h: int = 0,
) -> Tuple[bool, str]:
    """(allowed, reason). reason ∈ {"", "global_limit", "used", "owner"}."""
    try:
        glimit = int(cfg.get("globalDailyLimit") or 0)
    except (TypeError, ValueError):
        glimit = 0
    if glimit > 0 and int(videos_last_24h or 0) >= glimit:
        return False, "global_limit"

    try:
        reuse = max(1, int(cfg.get("requestReuseLimit") or 1))
    except (TypeError, ValueError):
        reuse = 1
    try:
        used = int(request.get("usedCount") or 0)
    except (TypeError, ValueError):
        used = 0
    if used >= reuse:
        return False, "used"

    try:
        bound = int(request.get("boundTgUid") or 0)
    except (TypeError, ValueError):
        bound = 0
    if bound and bound != int(uid or 0):
        return False, "owner"

    return True, ""


def _serializable_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """`message` (Telethon object) jaisi non-JSON cheezein hata kar copy."""
    return {k: v for k, v in (request or {}).items() if k != "message"}


# ─────────────────────────────────────────────────────────────────────────────
# CLI COMMANDS
# ─────────────────────────────────────────────────────────────────────────────
def cmd_login() -> int:
    """Bot ke liye ALAG user session banata hai (recommended)."""
    from telethon import TelegramClient
    from telethon.sessions import MemorySession

    api_id_raw = os.environ.get("TELEGRAM_API_ID", "").strip()
    api_hash = os.environ.get("TELEGRAM_API_HASH", "").strip()

    if not api_id_raw or not api_id_raw.isdigit():
        api_id_raw = input("👉 Telegram API ID (my.telegram.org): ").strip()
    if not api_hash:
        api_hash = input("👉 Telegram API Hash: ").strip()
    try:
        api_id = int(api_id_raw)
    except ValueError:
        print("❌ API ID numeric honi chahiye.")
        return 1

    phone = input("👉 Phone number with country code (+91...): ").strip()
    if phone and not phone.startswith("+"):
        phone = "+" + phone

    async def run() -> int:
        from telethon.errors import (
            PasswordHashInvalidError,
            PhoneCodeExpiredError,
            PhoneCodeInvalidError,
            SessionPasswordNeededError,
        )

        client = TelegramClient(MemorySession(), api_id, api_hash, use_ipv6=False)
        await client.connect()
        try:
            if not await client.is_user_authorized():
                sent = await client.send_code_request(phone)
                print("📩 OTP aapke Telegram app me bhej diya gaya hai.")
                while True:
                    code = input("👉 Enter OTP: ").strip().replace(" ", "").replace("-", "")
                    try:
                        await client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
                        break
                    except PhoneCodeInvalidError:
                        print("❌ Invalid OTP. Try again.")
                    except PhoneCodeExpiredError:
                        print("⚠️ OTP expired — sending a new one…")
                        sent = await client.send_code_request(phone)
                    except SessionPasswordNeededError:
                        while True:
                            pwd = input("👉 2FA password: ").strip()
                            try:
                                await client.sign_in(password=pwd)
                                break
                            except PasswordHashInvalidError:
                                print("❌ Wrong 2FA password.")
                        break

            me = await client.get_me()
            session_string = client.session.save()
            auth_key = client.session.auth_key
            print("\n" + "=" * 70)
            print("✅ LOGIN SUCCESSFUL — %s (id=%s)" % (me.first_name, me.id))
            print("=" * 70)
            print("\n👇 BOT SESSION STRING (copy this into TG_SESSION_STRING):\n")
            print(session_string)
            print("\n" + "=" * 70)
            print("Tip: isse .env me TG_SESSION_STRING=\"...\" me paste karein.")
            print("     Ya 'shd_user.session' file ko bot ke saath host par rakhein.")
            print("=" * 70)

            # local file bhi save kar do (agar user string use na kare)
            try:
                file_client = TelegramClient(os.path.join(HERE, "shd_user"), api_id, api_hash)
                file_client.session.set_dc(
                    client.session.dc_id,
                    client.session.server_address,
                    client.session.port,
                )
                file_client.session.auth_key = auth_key
                file_client.session.save()
                print("💾 Session file bhi save ho gayi: %s" % os.path.join(HERE, "shd_user.session"))
            except Exception as exc:  # noqa: BLE001
                print("⚠️ Session file save nahi ho payi (%s) — string use karein." % short_error(exc))

            # Bonus: OWNER_TG_ID (admin commands ke liye)
            print("\n👑 OWNER_TG_ID=%s   ← .env me daal dein (aap admin ban jayenge)" % me.id)

            save_choice = input("\n💾 Send this session string to your Telegram Saved Messages? (y/n) [n]: ").strip().lower()
            if save_choice in ("y", "yes"):
                await client.send_message(
                    "me",
                    "🔐 <b>Study helper Doc — BOT session string</b>\n"
                    "⚠️ Never share this with anyone.\n\n"
                    "<code>%s</code>" % session_string,
                )
                print("✅ Sent to Saved Messages.")
            return 0
        finally:
            await client.disconnect()

    try:
        return asyncio.run(run())
    except KeyboardInterrupt:
        print("\nCancelled.")
        return 1


def cmd_print_session() -> int:
    from telethon import TelegramClient

    api_id = int((os.environ.get("TELEGRAM_API_ID") or "0").strip() or 0)
    api_hash = (os.environ.get("TELEGRAM_API_HASH") or "").strip()
    if not api_id or not api_hash:
        print("❌ TELEGRAM_API_ID / TELEGRAM_API_HASH env me chahiye.")
        return 1
    path = os.path.join(HERE, "shd_user")
    if not os.path.exists(path + ".session"):
        print("❌ %s.session nahi mila. Pehle: python3 bot.py --login" % path)
        return 1
    client = TelegramClient(path, api_id, api_hash)
    session_string = client.session.save()
    if not session_string:
        print("❌ Session file khali hai. Dobara: python3 bot.py --login")
        return 1
    print("\nTG_SESSION_STRING=\"%s\"\n" % session_string)
    return 0


def cmd_info() -> int:
    store = create_store()
    creds = resolve_credentials(store)
    ok, message = check_credentials(creds)
    cfg = store.get_config()
    stats = store.stats()
    print("=" * 70)
    print(" STUDY HELPER DOC — BOT INFO")
    print("=" * 70)
    print(" storage backend : %s" % store.backend)
    print(" api id          : %s" % (creds["apiId"] or "❌ missing"))
    print(" api hash        : %s" % ("set (%d chars)" % len(creds["apiHash"]) if creds["apiHash"] else "❌ missing"))
    print(" bot token       : %s" % ("set" if creds["botToken"] else "❌ missing"))
    print(" user session    : %s" % (creds["sessionSource"] or "❌ missing (run: python3 bot.py --login)"))
    print(" credentials     : %s" % message)
    print(" vault decrypt   : %s" % ("ok" if __import__("vault").vault_key() else "unavailable (ADMIN_SESSION_SECRET missing)"))
    print("-" * 70)
    for key in ("dailyLimit", "autoDeleteHours", "deliveryMode", "creditUsername", "botUsername", "adminTgIds"):
        print(" %-15s : %s" % (key, cfg.get(key)))
    print("-" * 70)
    print(" users           : %s" % stats["totalUsers"])
    print(" videos sent     : %s" % stats["totalVideosSent"])
    print(" pending deletes : %s" % stats["pendingDeletions"])
    print("=" * 70)
    store.close()
    return 0 if ok else 2


def cmd_selftest() -> int:
    """Offline test — Telegram/Firebase connection ki zaroorat nahi."""
    import tempfile

    failures: List[str] = []

    def check(name: str, condition: bool, extra: Any = "") -> None:
        status = "✅" if condition else "❌"
        print("   %s %s%s" % (status, name, ("  → %s" % extra) if (extra and not condition) else ""))
        if not condition:
            failures.append(name)

    print("\n── matcher rules ────────────────────────────────────────────────")

    if _selftest() != 0:
        failures.append("matcher self-test")
    else:
        print("   ✅ matcher rules (SECTION 3)")

    print("\n── sqlite store ────────────────────────────────────────────────")
    with tempfile.TemporaryDirectory() as tmp:
        store = SqliteStoreForTest(os.path.join(tmp, "test.db"))
        check("config defaults (20/day)", store.get_config()["dailyLimit"] == 20)
        check("IST midnight reset default", store.get_config().get("dailyResetHourIST") == 0)
        store.save_config({"dailyLimit": 15})
        check("config save", store.get_config()["dailyLimit"] == 15)

        store.save_user(111, {"id": 111, "username": "ravi", "recent": []})
        check("user save/read", store.get_user(111).get("username") == "ravi")
        check("user list", len(store.list_users()) == 1)

        quota = store.quota_status(111)
        check("quota starts full", quota["remaining"] == 15, quota)
        for _ in range(15):
            store.consume_quota(111)
        quota = store.quota_status(111)
        check("quota exhausts at limit", quota["remaining"] == 0 and quota["used"] == 15, quota)
        check("reset timer set", quota["resetInSec"] > 0, quota)
        check("reset label is IST midnight", quota.get("resetsAtIST") == "12:00 AM", quota)
        check("reset within 24h", quota["resetInSec"] <= 86400, quota)

        # 🕛 IST day window: reset raat 12 baje Indian time (UTC+5:30) par
        w_start, w_end = daily_window_ms({"dailyResetHourIST": 0})
        check("IST window is 24h", w_end - w_start == 86400 * 1000, (w_start, w_end))
        check("IST window start aligned", (w_start // 1000 + IST_OFFSET_SEC) % 86400 == 0, w_start)
        check("IST window end aligned", (w_end // 1000 + IST_OFFSET_SEC) % 86400 == 0, w_end)
        check("now inside window", w_start <= _now_ms() < w_end, (w_start, _now_ms(), w_end))
        # kal subah IST window aage khisak jaye
        n_start, _ = daily_window_ms({"dailyResetHourIST": 0}, w_end + 1000)
        check("next day window shifts", n_start == w_end, (n_start, w_end))
        # doosra reset hour (jaise shaam 6 baje IST) bhi respect ho
        e_start, _e_end = daily_window_ms({"dailyResetHourIST": 18})
        check("custom reset hour aligned", (e_start // 1000 + IST_OFFSET_SEC) % 86400 == 18 * 3600, e_start)
        # purane (aaj se pehle ke) stamps count nahi hote
        store.save_user(222, {"id": 222, "username": "old", "recent": [w_start - 5000, _now_ms()]})
        q222 = store.quota_status(222)
        check("only today's IST videos counted", q222["used"] == 1, q222)
        check("videosToday in stats", int(store.stats().get("videosToday") or 0) >= 16, store.stats())

        check("stats total", store.stats()["totalVideosSent"] == 15, store.stats())

        store.add_deletion(111, 9001, int(time.time() * 1000) - 1000)
        store.add_deletion(222, 9002, int(time.time() * 1000) + 60000)
        check("due deletions", len(store.due_deletions()) == 1)
        check("pending deletions", len(store.pending_deletions()) == 2)
        due = store.due_deletions()[0]
        store.remove_deletion(str(due["_key"]))
        check("deletion removed", len(store.pending_deletions()) == 1)

        store.set_request("abc123", {"title": "Solid State", "createdAt": int(time.time() * 1000)})
        check("request save/read", store.get_request("abc123", ).get("title") == "Solid State")
        store.set_request("old1", {"title": "Old", "createdAt": int((time.time() - 40 * 86400) * 1000)})
        check("expired request rejected", store.get_request("old1") is None)

        store.set("bot_state/tasks/t1", {"type": "broadcast", "payload": {"message": "hi"}, "status": "pending"})
        tasks = store.claim_tasks()
        check("task claim", len(tasks) == 1 and tasks[0]["type"] == "broadcast")
        store.mark_task(str(tasks[0]["_key"]), "done", "ok")
        check("task done", len(store.claim_tasks()) == 0)

        store.log_event("delivered", uid=111, title="x")
        check("event log", len(store.recent_events()) >= 1)
        store.close()

    print("\n── vault (AES-256-GCM, website-compatible) ─────────────────────")
    os.environ["ADMIN_SESSION_SECRET"] = "selftest-secret-0123456789abcdef"
    check("vault key derived", vault_key() is not None)
    sample = {"apiId": 123456, "apiHash": "abc", "sessionString": "1xyz", "botToken": "123:AAA"}
    cipher = encrypt_vault_json(sample)
    check("vault cipher format", cipher.startswith("v1.") and cipher.count(".") == 3)
    check("vault roundtrip", decrypt_vault_json(cipher) == sample)
    check("vault tamper rejected", decrypt_vault_json(cipher[:-4] + "AAAA") is None)

    # GramJS → Telethon converter (session.py ke layout se synthetic string)

    auth_key = bytes(range(256))
    addr = b"149.154.167.51"
    gramjs = "1" + base64.b64encode(
        struct.pack(">B", 2) + struct.pack(">h", len(addr)) + addr + struct.pack(">h", 443) + auth_key
    ).decode()
    parsed = parse_gramjs_session(gramjs)
    check("gramjs parse", parsed is not None and parsed["dcId"] == 2 and parsed["port"] == 443)
    telethon_str = gramjs_to_telethon(gramjs)
    check("gramjs→telethon", bool(telethon_str) and len(base64.b64decode(telethon_str + "==")) == 264,
          len(base64.b64decode(telethon_str + "==")) if telethon_str else 0)
    check("telethon detect", looks_like_telethon_session(telethon_str or ""))
    check("gramjs not misdetected", not looks_like_telethon_session(gramjs))

    os.environ.pop("ADMIN_SESSION_SECRET", None)
    check("no secret → no key (dev only)", vault_key() is None or master_secret() == "shd_local_dev_master_key_v3")

    print("\n── delivery caption + topic path ───────────────────────────────")
    caption = build_delivery_caption(
        "Solid State Part 1", "Chemistry › Solid State", "12th मंजिल बैच 2027", "krishna84"
    )
    check("caption order", caption.index("📺") < caption.index("📚") < caption.index("🎓") < caption.index("Extracted By"))
    check("caption english labels", "Topic:" in caption and "Course:" in caption)
    check("caption credit", caption.rstrip().endswith("Extracted By @krishna84"))
    check("caption length safe", len(caption) <= 1024)
    check(
        "topic path builds",
        _topic_path({"folderPath": ["Chemistry", "Solid State"], "topic": "Solid State"}) == "Chemistry › Solid State",
        _topic_path({"folderPath": ["Chemistry", "Solid State"], "topic": "Solid State"}),
    )
    check("@ blocked in caption", "@" not in build_delivery_caption("Title @leak", "", "", "krishna84").replace("@krishna84", ""))

    print("\n── 🛡️ anti-theft gate (v6) ─────────────────────────────────────")
    gate_cfg = {**DEFAULT_CONFIG, "globalDailyLimit": 100, "requestReuseLimit": 1}
    fresh = {"title": "Solid State", "usedCount": 0, "boundTgUid": 0}
    ok, why = request_gate(fresh, 555, gate_cfg, videos_last_24h=10)
    check("fresh link allowed", ok and why == "", why)
    ok, why = request_gate({**fresh, "usedCount": 1}, 555, gate_cfg)
    check("used link rejected", (not ok) and why == "used", why)
    ok, why = request_gate({**fresh, "boundTgUid": 555}, 555, gate_cfg)
    check("owner can reuse bound link", ok and why == "", why)
    ok, why = request_gate({**fresh, "boundTgUid": 555}, 999, gate_cfg)
    check("other account blocked", (not ok) and why == "owner", why)
    ok, why = request_gate(fresh, 555, gate_cfg, videos_last_24h=100)
    check("global breaker trips", (not ok) and why == "global_limit", why)
    ok, why = request_gate(fresh, 555, {**gate_cfg, "globalDailyLimit": 0}, videos_last_24h=99999)
    check("global breaker off = allowed", ok and why == "", why)
    ok, why = request_gate({"usedCount": "2", "boundTgUid": "7"}, 7, {**gate_cfg, "requestReuseLimit": 2})

    # ── 🔒 join-gate ────────────────────────────────────────────────────────
    gate_off = {"joinGateEnabled": False, "joinGateChannel": "@shd"}
    gate_on = {"joinGateEnabled": True, "joinGateChannel": "@shd"}
    check("join-gate off", join_gate_state(gate_off, False) == "off")
    check("join-gate on + member", join_gate_state(gate_on, True) == "pass")
    check("join-gate on + not member", join_gate_state(gate_on, False) == "block")
    check("join-gate check failed = fail-open", join_gate_state(gate_on, None) == "unknown")
    check(
        "join-gate on but no channel = off",
        join_gate_state({"joinGateEnabled": True, "joinGateChannel": "  "}, False) == "off",
    )
    check(
        "invite url from username",
        _join_invite_url({"joinGateChannel": "@shd_channel"}) == "https://t.me/shd_channel",
    )
    check(
        "invite url explicit wins",
        _join_invite_url(
            {"joinGateChannel": "@shd", "joinGateInviteUrl": "https://t.me/+abc"}
        )
        == "https://t.me/+abc",
    )
    check(
        "invite url empty for private id",
        _join_invite_url({"joinGateChannel": "-1001234567890"}) == "",
    )
    check(
        "DEFAULT_CONFIG has join-gate keys",
        all(k in DEFAULT_CONFIG for k in ("joinGateEnabled", "joinGateChannel", "joinGateInviteUrl")),
    )

    # ── 🩺 health server (Render "Web Service" port) ───────────────────────
    import urllib.error
    import urllib.request

    _env_backup = {k: os.environ.get(k) for k in ("PORT", "BOT_HEALTH_PORT", "BOT_DISABLE_HEALTH")}

    def _restore_env() -> None:
        for key, value in _env_backup.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    try:
        os.environ.pop("BOT_DISABLE_HEALTH", None)
        os.environ.pop("BOT_HEALTH_PORT", None)
        os.environ["PORT"] = "10000"
        check("PORT from Render is picked up", health_port_from_env() == 10000)
        os.environ["BOT_HEALTH_PORT"] = "9111"
        check("BOT_HEALTH_PORT overrides PORT", health_port_from_env() == 9111)
        os.environ["BOT_DISABLE_HEALTH"] = "1"
        check("BOT_DISABLE_HEALTH=1 turns it off", health_port_from_env() is None)
        os.environ.pop("BOT_DISABLE_HEALTH", None)
        os.environ.pop("BOT_HEALTH_PORT", None)
        os.environ.pop("PORT", None)
        check("no PORT set = no server (local/VPS run)", health_port_from_env() is None)

        srv, _thr, port = start_health_server(0, provider=lambda: {"probe": "ok"})
        check("health server binds a port", srv is not None and port > 0)
        if srv is not None:
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/healthz" % port, timeout=5) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                    code = resp.getcode()
                check("/healthz -> 200 + ok:true", code == 200 and payload.get("ok") is True)
                check("/healthz carries live status", payload.get("probe") == "ok" and "uptimeSec" in payload)
                text = json.dumps(payload).lower()
                check(
                    "health payload leaks no secrets",
                    not any(
                        word in text
                        for word in ("session", "secret", "api_hash", "apihash", "private_key", "token", "password")
                    ),
                )
                try:
                    with urllib.request.urlopen("http://127.0.0.1:%d/ready" % port, timeout=5) as resp2:
                        ready_code = resp2.getcode()
                except urllib.error.HTTPError as exc:
                    ready_code = exc.code
                check("/ready is 503 until the bot is running", ready_code == 503)
                with urllib.request.urlopen("http://127.0.0.1:%d/status" % port, timeout=5) as resp3:
                    status_payload = json.loads(resp3.read().decode("utf-8"))
                check("/status returns JSON", isinstance(status_payload, dict) and status_payload.get("ok") is True)
            finally:
                stop_health_server(srv)
    finally:
        _restore_env()
    check("string fields handled", (not ok) and why == "used", why)
    check(
        "message object stripped",
        "message" not in _serializable_request({"title": "x", "message": object()}),
    )

    print("\n── helpers ─────────────────────────────────────────────────────")
    check("human_bytes", human_bytes(1536 * 1024) == "1.5 MB", human_bytes(1536 * 1024))
    check("human_time", human_time(3725) == "1h 02m", human_time(3725))
    check("short_error safe", "@secret" not in short_error(RuntimeError("failed @secret channel")))
    check("hours text", _hours_text(2.0) == "2" and _hours_text(1.5) == "1.5")

    print("\n── 🎬 delivery mode (per source) ───────────────────────────────")
    _cap = "Index: 1\nTitle: Solid State"
    pub = {"chat_public": True, "noforwards": False, "caption": _cap}
    prv = {"chat_public": False, "noforwards": False, "caption": _cap}
    restricted = {"chat_public": True, "noforwards": True, "caption": _cap}
    with_handle = {"chat_public": True, "noforwards": False, "caption": "Title: Solid State @somechannel"}
    check("public channel → forward", delivery_mode_for({"deliveryMode": "auto"}, pub) == "forward",
          delivery_mode_for({"deliveryMode": "auto"}, pub))
    check("private channel → clean", delivery_mode_for({"deliveryMode": "auto"}, prv) == "clean",
          delivery_mode_for({"deliveryMode": "auto"}, prv))
    check("forwarding not allowed → clean", delivery_mode_for({"deliveryMode": "auto"}, restricted) == "clean",
          delivery_mode_for({"deliveryMode": "auto"}, restricted))
    check("source @handle → clean", delivery_mode_for({"deliveryMode": "auto"}, with_handle) == "clean",
          delivery_mode_for({"deliveryMode": "auto"}, with_handle))
    check("admin force clean", delivery_mode_for({"deliveryMode": "clean"}, pub) == "clean")
    check("admin force forward", delivery_mode_for({"deliveryMode": "forward"}, prv) == "forward")
    check("force forward still respects noforwards",
          delivery_mode_for({"deliveryMode": "forward"}, restricted) == "clean")
    check("default deliveryMode = auto", DEFAULT_CONFIG.get("deliveryMode") == "auto",
          DEFAULT_CONFIG.get("deliveryMode"))

    print("\n── 🕛 daily limit reset (IST midnight) ─────────────────────────")
    check("reset label 0h = 12:00 AM", reset_time_label({"dailyResetHourIST": 0}) == "12:00 AM")
    check("reset label 18h = 6:00 PM", reset_time_label({"dailyResetHourIST": 18}) == "6:00 PM")
    check("reset label 12h = 12:00 PM", reset_time_label({"dailyResetHourIST": 12}) == "12:00 PM")
    check("reset label default = 12:00 AM", reset_time_label({}) == "12:00 AM")
    check("limit message is per-day (English)",
          "per day" in MSG_LIMIT_BODY and "{window}" not in MSG_LIMIT_BODY, MSG_LIMIT_BODY)
    check("auto-delete message wording",
          "This video will be deleted in" in MSG_AUTO_DELETE, MSG_AUTO_DELETE)
    check("status message is per-day", "per day" in MSG_STATUS and "{window}" not in MSG_STATUS)

    print("\n" + "=" * 70)
    if failures:
        print("❌ SELF-TEST FAILED: %d → %s" % (len(failures), ", ".join(failures)))
        return 1
    print("✅ SELF-TEST PASSED — bot offline logic is healthy")
    print("=" * 70 + "\n")
    return 0


def SqliteStoreForTest(path: str) -> Store:  # noqa: N802 (test helper)

    return SqliteStore(path)


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
# 🩺 HEALTH SERVER (Render/Railway "Web Service" ke liye PORT bind karna zaroori)
# ─────────────────────────────────────────────────────────────────────────────
_LIVE_BOT: Dict[str, Any] = {"bot": None, "store": None}


def bot_health_status() -> Dict[str, Any]:
    """Health endpoint ka payload — kabhi bhi secret (token/session) nahi deta."""
    info: Dict[str, Any] = {
        "service": "shd-telegram-bot",
        "pid": os.getpid(),
        "python": sys.version.split()[0],
    }
    bot = _LIVE_BOT.get("bot")
    store = _LIVE_BOT.get("store")
    if bot is not None:
        cfg = getattr(bot, "cfg", {}) or {}
        try:
            _st = (store.stats() if store else {}) or {}
            quota_all = int(_st.get("videosToday") or _st.get("videosLast24h") or 0)
        except Exception:  # noqa: BLE001
            quota_all = 0
        info.update(
            {
                "botUsername": str(cfg.get("botUsername") or ""),
                "storage": str(getattr(store, "backend", "")) if store else "",
                "deliveryMode": str(cfg.get("deliveryMode") or ""),
                "dailyLimit": cfg.get("dailyLimit"),
                "autoDeleteHours": cfg.get("autoDeleteHours"),
                "paused": bool(cfg.get("paused")),
                "globalDailyLimit": cfg.get("globalDailyLimit"),
                "videosLast24h": quota_all,
                "joinGate": (
                    "on:" + str(cfg.get("joinGateChannel"))
                    if cfg.get("joinGateEnabled") and str(cfg.get("joinGateChannel") or "").strip()
                    else "off"
                ),
                "queueDepth": int(getattr(bot, "_queue_depth", 0) or 0),
                "userSessionConnected": bool(
                    getattr(bot, "user", None) is not None and getattr(bot, "_me_id", 0)
                ),
            }
        )
    return info


async def run_bot() -> int:
    store = create_store()
    creds = resolve_credentials(store)
    ok, message = check_credentials(creds)
    if not ok:
        set_status(state="fatal", error=str(message)[:400])
        print("\n❌ %s" % message)
        print(
            "\nKahan se laayein:\n"
            "  • API ID / API Hash  → https://my.telegram.org (API development tools)\n"
            "  • Bot Token          → Telegram par @BotFather → /newbot\n"
            "  • Ya /admin → Telegram Sync Studio → Box 1 me save karein (vault se\n"
            "    bot khud padh lega, Firebase env vars chahiye).\n"
        )
        return 2
    if not creds.get("sessionString"):
        set_status(error="TG_SESSION_STRING missing — run: python bot.py --login")
        print(
            "\n⚠️  User session nahi mila. Bot chalu hone ke baad login maangega.\n"
            "   Recommended:  python3 bot.py --login   (alag session, safe)\n"
        )

    bot = DeliveryBot(store, creds)
    _LIVE_BOT["bot"] = bot
    _LIVE_BOT["store"] = store
    try:
        await bot.start()
    except SystemExit as exc:
        print(exc)
        set_status(state="fatal", error=str(exc).strip()[:400])
        return int(exc.code or 1)
    except Exception as exc:  # noqa: BLE001
        print("\n❌ Startup failed: %s" % short_error(exc))
        traceback.print_exc()
        set_status(state="fatal", error=short_error(exc)[:400])
        return 1
    set_status(state="running", error="", botUsername=str(bot.cfg.get("botUsername") or ""))

    print("\n🟢 Bot is running. Press Ctrl+C to stop.\n")
    stop_event = asyncio.Event()

    def _request_stop() -> None:
        if not stop_event.is_set():
            stop_event.set()

    for signal_name in ("SIGINT", "SIGTERM"):
        try:
            import signal

            asyncio.get_event_loop().add_signal_handler(getattr(signal, signal_name), _request_stop)
        except (NotImplementedError, RuntimeError, AttributeError):
            pass

    try:
        await stop_event.wait()
    except KeyboardInterrupt:
        pass
    finally:
        log("stopping…")
        set_status(state="stopped")
        _LIVE_BOT["bot"] = None
        _LIVE_BOT["store"] = None
        await bot.stop()
        store.close()
    return 0


async def supervise_bot(retry_wait_sec: int = 20, max_retries: int = -1) -> int:
    """Bot ko chalao; fail ho to process ko zinda rakhte hue retry karo.

    Render free tier par ye zaroori hai — warna chhoti si cred galti par service
    crash-loop karti hai aur health check fail hone par deploy hi reject ho jata
    hai. Yahan HTTP server chalta rehta hai, `/status` par asli error dikhta hai,
    aur bot har `retry_wait_sec` baad dubara koshish karta hai (admin ne vault me
    credentials save kiye to agla attempt apne aap chal padta hai).
    """
    attempt = 0
    while True:
        attempt += 1
        set_status(state="starting", attempt=attempt)
        code = await run_bot()
        if code == 0:
            return 0
        if max_retries >= 0 and attempt > max_retries:
            set_status(state="fatal", error="Max retries finished (last exit %s)." % code)
            return code
        wait = min(300, max(10, retry_wait_sec * attempt))
        set_status(state="retrying", attempt=attempt)
        log(
            "⚠️ Bot start nahi ho paya (exit=%s). %s second me dubara koshish — "
            "/status par reason dikhega." % (code, wait)
        )
        await asyncio.sleep(wait)


def main(argv: Optional[List[str]] = None) -> int:
    load_dotenv_files()
    parser = argparse.ArgumentParser(
        description="Study helper Doc — Telegram delivery bot",
        add_help=True,
    )
    parser.add_argument("--login", action="store_true", help="create a separate user session for the bot")
    parser.add_argument("--selftest", action="store_true", help="run offline self tests")
    parser.add_argument("--info", action="store_true", help="print credentials/config/state summary")
    parser.add_argument("--print-session", action="store_true", help="print TG_SESSION_STRING from shd_user.session")
    args = parser.parse_args(argv)

    if args.selftest:
        return cmd_selftest()
    if args.info:
        return cmd_info()
    if args.login:
        return cmd_login()
    if args.print_session:
        return cmd_print_session()

    # 🩺 Pehle HTTP port bind karo — Render ko deploy ke waqt port chahiye hota
    #    hai, isliye Telegram/Firebase connect se PEHLE server chalu hota hai.
    want_port = health_port_from_env()
    health_server = None
    if want_port:
        health_server, _thread, actual_port = start_health_server(
            want_port, provider=bot_health_status
        )
        if health_server is not None:
            log(
                "🩺 Health server ON → 0.0.0.0:%d  (paths: /healthz /ready /status)"
                % actual_port
            )
            print(
                "   Render health check path: /healthz\n"
                "   Free tier ko jagane ke liye koi external pinger isi path par "
                "5-10 min me ek baar hit karein."
            )
        else:
            log("⚠️ Health server port %s bind nahi ho paya — bot phir bhi chalega." % want_port)

    no_retry = str(os.environ.get("BOT_NO_RETRY") or "").strip() in ("1", "true", "yes")
    try:
        if no_retry:
            return asyncio.run(run_bot())
        return asyncio.run(supervise_bot())
    except KeyboardInterrupt:
        print("\n👋 Bot stopped.")
        return 0
    finally:
        stop_health_server(health_server)


if __name__ == "__main__":
    raise SystemExit(main())
