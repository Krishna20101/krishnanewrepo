# 🤖 Study Helper Doc — Telegram Delivery Bot

Ye chhota service **Render** (ya Railway/VPS) par chalta hai aur teen kaam karta hai:

1. Site ke **Open in Telegram** button se aane wale user ko verify karta hai.
2. **Join gate** — channel join nahi hai to "Join our channel" + "Continue" button dikhata hai.
   Continue dabane par `getChatMember` se **live check** hota hai.
3. Join hone par **wahi video** user ko bhejta hai (`copyMessage` — source group me
   forwarding off ho to bhi kaam karta hai) aur **3 ghante baad** video + notice
   dono message **apne aap delete** kar deta hai.

## 1. BotFather setup
```
/newbot  →  naam + username  →  BOT_TOKEN copy
```
- Bot ko **saare course groups/channels me ADMIN** banayein (copy/forward permission ke saath).
- Join gate ke liye apne **public channel** me bhi bot ko admin banayein.

## 2. Render deploy
1. https://render.com → **New → Web Service**
2. GitHub repo connect → **Root Directory**: `telegram-bot`
3. Build command: `npm install` · Start command: `npm start`
4. Environment variables (`.env.example` dekhein):
   - `BOT_TOKEN`
   - `ADMIN_SESSION_SECRET` ← **Vercel wali same value** (zaroori!)
   - `CHANNEL_ID`, `CHANNEL_URL`, `CHANNEL_INVITE_URL`
   - `WEBHOOK_URL` = `https://<your-service>.onrender.com`
   - `SESSION_TTL_HOURS=3`
5. Deploy hone par `/health` par `{"ok":true}` aana chahiye.

## 3. Site par 2 env vars (Vercel → Settings → Environment Variables)
```
NEXT_PUBLIC_TELEGRAM_BOT_USERNAME=your_bot_username
NEXT_PUBLIC_TELEGRAM_CHANNEL_URL=https://t.me/your_channel_username
```
Website ka **Open in Telegram** button inhi se banega.

## Flow
```
Site /watch → "Open in Telegram" → t.me/<bot>?start=<encrypted 20-min token>
     ↓
Bot decrypt karta hai (chat id + message id) → join check
     ↓ join nahi  → Join channel + Continue (re-check)
     ↓ join haan  → video copy → "3 ghante me delete" notice → auto delete
```

## Local test
```bash
cd telegram-bot
cp .env.example .env      # values bhar dein
npm install
npm start
```
