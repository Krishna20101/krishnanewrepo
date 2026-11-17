#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
===============================================================================
 STUDY HELPER DOC — VAULT + TELEGRAM CREDENTIAL RESOLVER  (vault.py)
===============================================================================
 Website (Next.js) aapke Telegram credentials ko Firebase RTDB me
 AES-256-GCM vault me encrypt karke rakhta hai:

     telegram_vault/encrypted_creds = { cipher: "v1.<iv>.<tag>.<data>" }

 Ye file WAHI vault Python side par decrypt karti hai — matlab aapko bot ke
 liye credentials dobara daalne ki zaroorat NAHI. Jo secrets aapne Vercel me
 daale hain (ADMIN_SESSION_SECRET / FIREBASE_*), wahi yahan bhi lagenge.

 Key derivation (src/lib/tgCrypto.ts ka exact mirror):
     secret = ADMIN_SESSION_SECRET
              || "ADMIN_EMAIL:ADMIN_PASSWORD:FIREBASE_PROJECT_ID"
              || "shd_local_dev_master_key_v3"   (sirf local dev)
     key    = scrypt(secret, salt="shd_tg_media_vault_v3_2026", N=16384,r=8,p=1, 32)

 ── SESSION STRING KI ZAROOI BAAT ────────────────────────────────────────────
 Website wali session string GRAMJS format me hoti hai; Telethon (Python) usko
 seedha nahi padh sakta. Isliye yahan `gramjs_to_telethon()` converter hai —
 par EK HI SESSION ko 2 jagah (Vercel + bot host) use karne se Telegram
 session ko terminate kar deta hai (wahi purana 406/AUTH_KEY_DUPLICATED).

 ➜ Recommendation: bot ke liye ALAG session banayein →  python3 bot.py --login
   (Aapke account me 2 active sessions dikhenge — bilkul safe hai.)
   Converter sirf ek-click start ke liye rakha gaya hai (warning ke saath).
===============================================================================
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import socket
import struct
from typing import Any, Dict, Optional, Tuple

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
