#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
===============================================================================
   STUDY HELPER DOC — TELEGRAM DELIVERY BOT   (bot.py)
===============================================================================
 Website par video ke jagah ab ek button hai:  ▶ OPEN IN TELEGRAM
 Wo button ek deep-link kholta hai:  https://t.me/<your_bot>?start=<requestId>

 Bot kya karta hai
 -----------------
  1) `requestId` se Firebase RTDB me video ka record padhta hai
     (chatId + messageId + title + topic + course + size).
  2) Agar record me message nahi milta (delete ho gaya / file_reference purani)
     to aapke SAARE groups/channels me SEARCH karta hai:
        • COURSE NAME match MANDATORY (12th / मंजिल / Crash Course / NEET ...)
        • TITLE + TOPIC fuzzy match (Hindi + English, aage-peeche order chalega)
        • 2 channel me same video mile → SIRF BEST MATCH (duplicate nahi jata)
        • @username kabhi nahi dikhta (caption se hamesha strip)
  3) Delivery:
        • Default `clean` mode → download + fresh upload
          → "Forwarded from ..." NAHI dikhta, caption APNA hota hai
            (Title / Topic / Course / Extracted By @<credit>)
        • `forward` mode → seedha forward (fast) — par agar source caption me
          @username hai ya channel restricted hai to bot khud `clean` par
          aa jata hai (rule kabhi break nahi hota).
  4) Live progress:  ⬇ Downloading... 42% • 3.4 MB/s  →  ⬆ Uploading... 65%
  5) Video 2 ghante baad AUTO-DELETE (restart-safe queue).
  6) Daily limit: 12 video / 24h per user (admin badal sakta hai).
  7) Har message ENGLISH me (koi Hindi text user ko nahi jata).

 Commands
 --------
  User :  /start <requestId>  /help  /status  /find <course> | <title>
  Admin:  /stats /users /limit_up <uid> <n> /limit_down <uid> <n>
          /limit_set <uid> <n> /limit_add <uid> <n> /limit_all <n>
          /limit_default <n> /broadcast <message> /ban <uid> /unban <uid>
          /pending /config /pause /resume /ping

 CLI
 ---
  python3 bot.py                 → bot chalao
  python3 bot.py --login         → bot ke liye ALAG user session banao (recommended)
  python3 bot.py --selftest      → offline test (matcher, vault, store, quota)
  python3 bot.py --info          → credentials/config/state ka summary
  python3 bot.py --print-session → session file → TG_SESSION_STRING bana kar print

 Env (website wale hi Vercel secrets chal jate hain) → .env.example dekhein
===============================================================================
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import re
import sys
import time
import traceback
from typing import Any, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from matcher import (  # noqa: E402
    MATCH_THRESHOLD,
    build_delivery_caption,
    clean_text,
    course_match_score,
    dedupe_candidates,
    parse_caption,
    safe_display_name,
    score_candidate,
    search_query,
    strip_usernames,
)
from store import DEFAULT_CONFIG, Store, create_store  # noqa: E402
from vault import check_credentials, resolve_credentials  # noqa: E402

# ─────────────────────────────────────────────────────────────────────────────
# ENGLISH-ONLY USER MESSAGES  (user rule: kabhi Hindi nahi)
# ─────────────────────────────────────────────────────────────────────────────
MSG_WELCOME = (
    "👋 Welcome to {app}!\n\n"
    "Open any lecture on the website and tap ▶ OPEN IN TELEGRAM.\n"
    "This bot will send that video here within a few minutes.\n\n"
    "📌 Your daily limit: {limit} videos / {window} hours\n"
    "⏳ Every video is deleted automatically after {hours} hours\n\n"
    "Commands: /status  /help"
)
MSG_HELP = (
    "ℹ️ How to use this bot\n\n"
    "1. Open the lecture on {app}\n"
    "2. Tap ▶ OPEN IN TELEGRAM\n"
    "3. Come back here — the video will arrive with live progress\n\n"
    "📌 Daily limit: {limit} videos / {window} hours\n"
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
    "⏳ This video will be deleted automatically after {hours} hours.\n"
    "Please watch or save it before that."
)
MSG_LIMIT_TITLE = "⛔ Your daily limit is finished."
MSG_LIMIT_BODY = (
    "\n\nYou can watch {limit} videos in {window} hours.\n"
    "Used: {used}/{limit} • Resets in {reset}\n\n"
    "To increase your limit, contact @{contact}"
)
MSG_STATUS = (
    "📊 Your usage\n\n"
    "Limit: {limit} videos / {window} hours\n"
    "Used: {used} • Remaining: {remaining}\n"
    "Resets in: {reset}\n"
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
            "limit": int(self._num("dailyLimit", 12)),
            "window": int(self._num("quotaWindowHours", 24)),
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
        log(
            "✅ Bot ready • mode=%s • limit=%s/24h • auto-delete=%sh • storage=%s"
            % (
                self.cfg.get("deliveryMode"),
                self.cfg.get("dailyLimit"),
                self.cfg.get("autoDeleteHours"),
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
                "Videos sent (last 24h): %d\n"
                "Pending auto-deletes: %d\n"
                "Storage backend: %s\n"
                "Bot: @%s\n"
                "Uptime: %s\n"
                "Delivery mode: %s\n"
                "Default limit: %d / %dh\n"
                "Auto-delete: %sh"
                % (
                    stats["totalUsers"],
                    stats["totalVideosSent"],
                    stats["videosLast24h"],
                    stats["pendingDeletions"],
                    stats["backend"],
                    stats["botUsername"] or "?",
                    human_time(time.time() - self.started_at),
                    self.cfg.get("deliveryMode"),
                    int(self._num("dailyLimit", 12)),
                    int(self._num("quotaWindowHours", 24)),
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
                current = int(self._num("dailyLimit", 12))
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
        mode = str(self.cfg.get("deliveryMode") or "clean").lower()

        # RULE: @username kabhi user tak nahi jana chahiye → forward mode me bhi
        # agar source caption me @handle hai to clean (re-upload) par switch.
        if mode == "forward" and ("@" in source_caption or noforwards):
            log("forward mode → clean mode (source has @username or is restricted)")
            mode = "clean"

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
            if request_id and request_id != "find":
                self.store.set_request(
                    request_id,
                    {
                        **{k: v for k, v in request.items() if k != "message"},
                        "deliveredTo": int(uid),
                        "deliveredAt": int(time.time() * 1000),
                        "deleteAt": delete_at,
                        "deliveryMode": mode,
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
    from matcher import _selftest as matcher_selftest

    if matcher_selftest() != 0:
        failures.append("matcher self-test")
    else:
        print("   ✅ matcher.py all rules")

    print("\n── sqlite store ────────────────────────────────────────────────")
    with tempfile.TemporaryDirectory() as tmp:
        store = SqliteStoreForTest(os.path.join(tmp, "test.db"))
        check("config defaults", store.get_config()["dailyLimit"] == 12)
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
    import importlib

    import vault as vault_module

    importlib.reload(vault_module)
    check("vault key derived", vault_module.vault_key() is not None)
    sample = {"apiId": 123456, "apiHash": "abc", "sessionString": "1xyz", "botToken": "123:AAA"}
    cipher = vault_module.encrypt_vault_json(sample)
    check("vault cipher format", cipher.startswith("v1.") and cipher.count(".") == 3)
    check("vault roundtrip", vault_module.decrypt_vault_json(cipher) == sample)
    check("vault tamper rejected", vault_module.decrypt_vault_json(cipher[:-4] + "AAAA") is None)

    # GramJS → Telethon converter (session.py ke layout se synthetic string)
    import struct

    auth_key = bytes(range(256))
    addr = b"149.154.167.51"
    gramjs = "1" + base64.b64encode(
        struct.pack(">B", 2) + struct.pack(">h", len(addr)) + addr + struct.pack(">h", 443) + auth_key
    ).decode()
    parsed = vault_module.parse_gramjs_session(gramjs)
    check("gramjs parse", parsed is not None and parsed["dcId"] == 2 and parsed["port"] == 443)
    telethon_str = vault_module.gramjs_to_telethon(gramjs)
    check("gramjs→telethon", bool(telethon_str) and len(base64.b64decode(telethon_str + "==")) == 264,
          len(base64.b64decode(telethon_str + "==")) if telethon_str else 0)
    check("telethon detect", vault_module.looks_like_telethon_session(telethon_str or ""))
    check("gramjs not misdetected", not vault_module.looks_like_telethon_session(gramjs))

    os.environ.pop("ADMIN_SESSION_SECRET", None)
    importlib.reload(vault_module)
    check("no secret → no key (dev only)", vault_module.vault_key() is None or vault_module.master_secret() == "shd_local_dev_master_key_v3")

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

    print("\n── helpers ─────────────────────────────────────────────────────")
    check("human_bytes", human_bytes(1536 * 1024) == "1.5 MB", human_bytes(1536 * 1024))
    check("human_time", human_time(3725) == "1h 02m", human_time(3725))
    check("short_error safe", "@secret" not in short_error(RuntimeError("failed @secret channel")))
    check("hours text", _hours_text(2.0) == "2" and _hours_text(1.5) == "1.5")

    print("\n" + "=" * 70)
    if failures:
        print("❌ SELF-TEST FAILED: %d → %s" % (len(failures), ", ".join(failures)))
        return 1
    print("✅ SELF-TEST PASSED — bot offline logic is healthy")
    print("=" * 70 + "\n")
    return 0


def SqliteStoreForTest(path: str) -> Store:  # noqa: N802 (test helper)
    from store import SqliteStore

    return SqliteStore(path)


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────
async def run_bot() -> int:
    store = create_store()
    creds = resolve_credentials(store)
    ok, message = check_credentials(creds)
    if not ok:
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
        print(
            "\n⚠️  User session nahi mila. Bot chalu hone ke baad login maangega.\n"
            "   Recommended:  python3 bot.py --login   (alag session, safe)\n"
        )

    bot = DeliveryBot(store, creds)
    try:
        await bot.start()
    except SystemExit as exc:
        print(exc)
        return int(exc.code or 1)
    except Exception as exc:  # noqa: BLE001
        print("\n❌ Startup failed: %s" % short_error(exc))
        traceback.print_exc()
        return 1

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
        await bot.stop()
        store.close()
    return 0


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

    try:
        return asyncio.run(run_bot())
    except KeyboardInterrupt:
        print("\n👋 Bot stopped.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
