#!/usr/bin/env node
/**
 * ============================================================================
 *  STUDY HELPER DOC — TELEGRAM DELIVERY BOT  (Render / Railway / VPS)
 * ============================================================================
 *  Kaam:
 *   1. Site ke "Open in Telegram" button se (?start=<token>) user aata hai.
 *   2. Bot token decrypt karta hai → course group ka chat id + message id milta hai.
 *   3. JOIN GATE: agar user channel join nahi hai → "Join our channel" button +
 *      "Continue" button. Continue par getChatMember se live check hota hai.
 *   4. Join hai → wahi video ORIGINAL message se copy karke user ko bhejta hai
 *      (source group me forward OFF/ON koi farak nahi — copyMessage use hota hai).
 *   5. 3 ghante baad video + notice message dono apne aap delete.
 *
 *  Render par deploy:
 *    Node version 18+, build command:  npm install
 *    start command:                    npm start
 *    Env vars:
 *      BOT_TOKEN                      (BotFather token)
 *      ADMIN_SESSION_SECRET           (site ke env se SAME — token decrypt ke liye)
 *      CHANNEL_URL / CHANNEL_ID       (join gate; @username ya -100xxxx)
 *      CHANNEL_INVITE_URL             (optional public invite link)
 *      BOT_USERNAME                   (optional, sirf logs ke liye)
 *      WEBHOOK_URL                    (Render public URL, jaise https://x.onrender.com)
 *      PORT                           (Render khud deta hai)
 *      SESSION_TTL_HOURS              (default 3)
 * ============================================================================
 */

require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

// ── Config ─────────────────────────────────────────────────────────────────
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const ADMIN_SESSION_SECRET = (process.env.ADMIN_SESSION_SECRET || "").trim();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();
const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || "").trim();

const CHANNEL_URL = (process.env.CHANNEL_URL || "").trim();
const CHANNEL_INVITE_URL = (process.env.CHANNEL_INVITE_URL || "").trim();
const CHANNEL_ID = (process.env.CHANNEL_ID || "").trim();
const PORT = parseInt(process.env.PORT || "3000", 10);
const TTL_HOURS = Math.max(1, parseInt(process.env.SESSION_TTL_HOURS || "3", 10));
const TTL_MS = TTL_HOURS * 60 * 60 * 1000;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN missing. Render → Environment me BOT_TOKEN daalein.");
  process.exit(1);
}
if (!ADMIN_SESSION_SECRET && !(ADMIN_EMAIL && ADMIN_PASSWORD)) {
  console.error(
    "❌ ADMIN_SESSION_SECRET missing. Site ke Vercel env wali SAME value daalein."
  );
  process.exit(1);
}

// ── Handoff token decrypt (site ke botHandoff.ts se bilkul same) ───────────
const FALLBACK_SALT = "shd_bot_handoff_v1_2026";
const HANDOFF_TTL_SEC = 20 * 60;

function masterKey() {
  const secret =
    ADMIN_SESSION_SECRET ||
    `${ADMIN_EMAIL}:${ADMIN_PASSWORD}:${FIREBASE_PROJECT_ID}` ||
    "shd_local_dev_master_key_v3";
  return crypto.scryptSync(secret, FALLBACK_SALT, 32);
}

function verifyHandoffToken(token) {
  if (!token) return null;
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      masterKey(),
      Buffer.from(ivB64, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");

    const parsed = JSON.parse(dec);
    if (!parsed || !parsed.c || !parsed.m) return null;
    if (typeof parsed.iat !== "number") return null;
    if (Math.floor(Date.now() / 1000) - parsed.iat > HANDOFF_TTL_SEC) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Bot ────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// pending: userId → { c, m, t, b, f, tries }
const pendingByUser = new Map();

// scheduled deletions
const deleteQueue = new Map(); // key → timer

function scheduleDelete(chatId, messageId) {
  const key = `${chatId}:${messageId}`;
  if (deleteQueue.has(key)) return;
  const timer = setTimeout(async () => {
    deleteQueue.delete(key);
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch {
      /* already gone — fine */
    }
  }, TTL_MS);
  // Render/Vercel ke long-running process me timer ko alive rakho, lekin
  // event loop block mat karo
  if (timer.unref) timer.unref();
  deleteQueue.set(key, timer);
}

async function safeSend(chatId, text, options = {}) {
  try {
    const msg = await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...options,
    });
    scheduleDelete(chatId, msg.message_id);
    return msg;
  } catch (err) {
    console.error("sendMessage failed:", err.message);
    return null;
  }
}

// ── Join gate ──────────────────────────────────────────────────────────────
function joinButtons() {
  const rows = [];
  const channelLink = CHANNEL_INVITE_URL || CHANNEL_URL;
  if (channelLink) {
    rows.push([{ text: "📢 Join our channel", url: channelLink }]);
  }
  rows.push([{ text: "✅ Continue", callback_data: "check_join" }]);
  return { inline_keyboard: rows };
}

/** @returns {Promise<boolean>} user channel member hai ya nahi */
async function isChannelMember(userId) {
  if (!CHANNEL_ID) return true; // join gate configured nahi hai
  try {
    const member = await bot.getChatMember(CHANNEL_ID, userId);
    const status = member && member.status;
    return (
      status === "creator" ||
      status === "administrator" ||
      status === "member" ||
      (status === "restricted" && member.is_member === true)
    );
  } catch (err) {
    console.error("getChatMember failed:", err.message);
    return false;
  }
}

// ── Video delivery ─────────────────────────────────────────────────────────
async function deliverVideo(chatId, payload) {
  const captionTitle = payload.t ? `🎬 <b>${escapeHtml(payload.t)}</b>` : "";
  const meta = [payload.b, payload.f].filter(Boolean).map(escapeHtml).join(" · ");

  // 1) original message copy (upstream "forwarding off" ho to bhi kaam karta hai)
  let copied = null;
  try {
    copied = await bot.copyMessage(chatId, payload.c, payload.m);
  } catch (err) {
    console.error("copyMessage failed:", err.message);
    // Fallback: forward try kar lo
    try {
      copied = await bot.forwardMessage(chatId, payload.c, payload.m);
    } catch (err2) {
      console.error("forwardMessage failed:", err2.message);
    }
  }

  if (!copied) {
    await safeSend(
      chatId,
      [
        "⚠️ <b>Video could not be delivered</b>",
        "",
        "The file may have been removed, or the bot is no longer an admin in that course group.",
        "",
        "👉 Please go back to the site and tap <b>Open in Telegram</b> again.",
      ].join("\n")
    );
    return false;
  }

  scheduleDelete(chatId, copied.message_id);

  // 2) title/meta note (chhota), phir expiry notice
  if (captionTitle || meta) {
    await safeSend(
      chatId,
      [captionTitle, meta ? `<i>${meta}</i>` : ""].filter(Boolean).join("\n")
    );
  }

  // 3) 3-hour expiry notice
  await safeSend(
    chatId,
    [
      "⏳ <b>This content will be deleted automatically in " + TTL_HOURS + " hours.</b>",
      "",
      "Save nothing, share nothing — it disappears from this chat on its own.",
      "",
      "🔁 Need it again later? Open the site and tap <b>Open in Telegram</b>.",
    ].join("\n")
  );

  return true;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── /start handler ─────────────────────────────────────────────────────────
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from && msg.from.id;
  const arg = match && match[1] ? String(match[1]).trim() : "";

  if (!arg) {
    await safeSend(
      chatId,
      [
        "👋 <b>Welcome to Study Helper Doc</b>",
        "",
        "This bot delivers your lectures privately.",
        "",
        "👉 Open the website, choose a lecture and tap <b>Open in Telegram</b>. The video will arrive here.",
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: CHANNEL_INVITE_URL || CHANNEL_URL
            ? [[{ text: "📢 Join our channel", url: CHANNEL_INVITE_URL || CHANNEL_URL }]]
            : [],
        },
      }
    );
    return;
  }

  const payload = verifyHandoffToken(arg);
  if (!payload) {
    await safeSend(
      chatId,
      [
        "⌛ <b>This link has expired or is invalid.</b>",
        "",
        "For security, delivery links are valid for 20 minutes only.",
        "",
        "👉 Go back to the site and tap <b>Open in Telegram</b> again.",
      ].join("\n")
    );
    return;
  }

  // JOIN GATE
  const joined = await isChannelMember(userId);
  if (!joined) {
    pendingByUser.set(String(userId), payload);
    await safeSend(
      chatId,
      [
        "🔒 <b>Almost there!</b>",
        "",
        "Please <b>join our channel</b> first, then tap <b>Continue</b>.",
        "",
        "If the video does not arrive, go back to the site and tap <b>Open in Telegram</b> once more.",
      ].join("\n"),
      { reply_markup: joinButtons() }
    );
    return;
  }

  await safeSend(chatId, "✅ <b>Verified.</b> Sending your video now…");
  await deliverVideo(chatId, payload);
});

// ── Continue / refresh button ──────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const userId = query.from && query.from.id;
  const chatId = query.message && query.message.chat.id;
  if (!userId || !chatId) return;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch {
    /* ignore */
  }

  if (query.data !== "check_join") return;

  const payload = pendingByUser.get(String(userId));
  if (!payload) {
    await safeSend(
      chatId,
      [
        "⌛ <b>Session expired.</b>",
        "",
        "👉 Go back to the site and tap <b>Open in Telegram</b> again.",
      ].join("\n")
    );
    return;
  }

  const joined = await isChannelMember(userId);
  if (!joined) {
    await safeSend(
      chatId,
      [
        "❌ <b>You have not joined the channel yet.</b>",
        "",
        "1️⃣ Tap <b>Join our channel</b>",
        "2️⃣ Come back and tap <b>Continue</b>",
      ].join("\n"),
      { reply_markup: joinButtons() }
    );
    return;
  }

  pendingByUser.delete(String(userId));
  await safeSend(chatId, "✅ <b>Verified.</b> Sending your video now…");
  await deliverVideo(chatId, payload);
});

// ── Delivery failure hint ──────────────────────────────────────────────────
bot.on("error", (err) => console.error("bot error:", err.message));
bot.on("polling_error", (err) => console.error("polling error:", err.message));

// ── Webhook server (Render) ────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "shd-telegram-bot", ttlHours: TTL_HOURS });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

async function start() {
  const webhookUrl = (process.env.WEBHOOK_URL || "").trim().replace(/\/$/, "");

  if (webhookUrl) {
    try {
      await bot.setWebHook(`${webhookUrl}/bot${BOT_TOKEN}`, {
        drop_pending_updates: true,
      });
      console.log(`🔗 Webhook set: ${webhookUrl}/bot***`);
    } catch (err) {
      console.error("setWebHook failed:", err.message);
    }
  } else {
    // Render par public URL ho to WEBHOOK_URL daalein; warna polling chalega
    bot.startPolling({ restart: true });
    console.log("📡 Polling mode (WEBHOOK_URL set nahi hai)");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Bot service listening on 0.0.0.0:${PORT}`);
    console.log(`⏱  Auto-delete after ${TTL_HOURS} hours`);
    console.log(
      `📢 Join gate: ${CHANNEL_ID ? "ON (" + CHANNEL_ID + ")" : "OFF (CHANNEL_ID not set)"}`
    );
  });
}

start();
