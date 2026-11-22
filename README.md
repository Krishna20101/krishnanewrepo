# 📚 Study helper Doc — v5 (clean rebuild)

Courses browser + **Telegram video delivery**. Website video **play nahi karti,
download nahi karti** — watch page ek **video-player jaisa frame** hai (thumbnail +
HUD), aur bich me **sirf EK gol ▶ button**:

> **▶ Open in Telegram** → bot khulta hai → channel-join check → video aapke
> Telegram chat me → **2 ghante baad auto-delete**
>
> Koi player controls nahi, koi share/turn-screen/notes buttons nahi — sirf wahi
> ek button jo Telegram kholta hai.

```
┌──────────────┐   POST /api/tg/request    ┌─────────────────┐
│  index.html  │ ────────────────────────► │    server.js    │  Node + Express
│  site/*.js   │ ◄──── requestId, link ─── │  (Render web)   │  Firebase RTDB
└──────┬───────┘                           └────────┬────────┘
       │  t.me/<bot>?start=req_<id>                 │ tg_requests/<id>
       ▼                                            ▼
┌──────────────┐    video + caption + auto-delete  ┌─────────────────┐
│   Telegram   │ ◄──────────────────────────────── │   bot/bot.py    │  Python
│     user     │                                   │  (Render web)   │  Telethon
└──────────────┘                                   └─────────────────┘
```

---

## 1 · Repository (chhoti aur saaf)

```
index.html              website shell (root)
server.js               Express server: static + /api/* + Firebase RTDB
package.json            express, firebase-admin, dotenv
render.yaml             Render blueprint (site + bot, dono free Web Service)
database.rules.json     Firebase RTDB rules (client read/write: false — sab server se)
.env.example            saare env vars (copy → .env.local)
README.md               yeh file

site/                   website ka saara js/css (koi sub-folder nahi)
  style.css             v5 "Slate & Ember" theme
  guard.js              auth guard, api wrapper, toasts
  app.js                student pages (home, courses, tree, watch, requests)
  admin.js              admin panel (8 tabs)

bot/                    Telegram bot (sirf 2 files)
  bot.py                vault + store + matcher + health + bot — ek file
  requirements.txt      telethon, firebase-admin deps, cryptography

data/batches/*.json     real course data — READ ONLY (kabhi modify nahi hota)
```

Website me **koi player, koi download, koi Cloudflare worker, koi GramJS session
nahi**. Purana streaming system poora hata diya gaya hai.

---

## 2 · Rules (jo hamesha follow hote hain)

| Rule | Kaise |
| --- | --- |
| **20 video / din / Telegram id** | `dailyLimit: 20` (bot + website dono jagah) |
| **Limit reset raat 12 baje (IST)** | fixed day-window `00:00 Asia/Kolkata` — rolling 24h nahi |
| **Website par sirf ek line** | `18 of 20 left today · resets 12:00 AM` — baaki messaging bot me English me |
| **Public source → direct forward** | channel public + forwarding allowed → `forward_messages` (fast) |
| **Private / no-forward → download+upload** | source ki pehchaan kabhi nahi dikhti |
| **Caption order** | `Title → Topic → Course → Extracted By @krishna84` |
| **Bot ki har baat English** | koi Hindi message nahi |
| **File-backed courses protected** | `data/batches/*.json` kabhi edit/delete nahi — DB override only |
| **Har failure dikhta hai** | koi chup-chaap hang nahi hota (bot + website dono me error surface) |

### 👤 Session vs 🤖 Bot — kaun kya karta hai

Aapke **USER session** (`TG_SESSION_STRING`) aur **bot** (`TELEGRAM_BOT_TOKEN`) ka
kaam alag hai. Bot ko private channel me admin ya member hone ki **zaroorat nahi**.

| Source | Download kaun karta hai | Student ko kaun bhejta hai |
| --- | --- | --- |
| **Private channel/group** | 🧑 aapka **USER session** (woh member hai) | 🤖 **bot** (fresh upload, source kabhi nahi dikhta) |
| **Public + forwarding allowed** | — (download hi nahi hota) | 🤖 **bot** seedha **forward** karta hai |
| **Public par `noforwards`** | 🧑 USER session | 🤖 bot (fresh upload) |
| **Caption me doosron ka `@handle`** | 🧑 USER session | 🤖 bot (fresh upload, handle leak nahi hota) |

- Video **hamesha bot ke chat me hi** aati hai — forward bhi `self.bot` se hota hai,
  isliye aapka personal account student ke saamne nahi aata aur 2-ghante wali
  auto-delete sahi message par lagti hai.
- **Public channel me forward fast path** chahiye to us channel/group me bot ko
  **member add** kar dijiye (admin zaroori nahi). Bot access nahi kar paaya to koi
  error nahi aayega — bot chup-chaap **session-download + fresh upload** par
  fallback kar dega (event log: `forward_fallback`).
- Bot ko **admin** sirf tab chahiye jab **join-gate** ON ho (membership check ke liye).

### Matching (bot)
Sirf wahi compare hota hai jo caption me **actually likha** hai:

- title / topic / course — teeno ka weighted score (threshold 60)
- **folder skip** ho jaye (topic caption me na ho) → topic ka weight title me chala jaata hai
- **course naam alag jagah** ho → topic-path, caption-topic aur title me bhi dhoondha jaata hai
  (jaise topic `Crash Course 2026` course `All Study Material` ke andar — same course)
- `All Study Material`, `PDF`, `Notes` jaise **generic folder** naam par reject nahi hota
- `12th मंजिल बैच` vs `11th परिवर्तन बैच` → **hard reject** (galat batch ki video nahi jayegi)
- Part guard: Part 1 kabhi Part 2 se match nahi karta
- Same naam kai groups me → **sabse zyada score wala group** jeet-ta hai

---

## 3 · Local run

```bash
# website
npm install
cp .env.example .env.local      # secrets bhariye
npm start                       # http://localhost:3000

# bot (self-test — Telegram/Firebase ke bina offline logic check)
python3 -m venv .venv-bot && .venv-bot/bin/pip install -r bot/requirements.txt
.venv-bot/bin/python bot/bot.py --selftest

# bot login (USER session string banane ke liye, ek baar)
.venv-bot/bin/python bot/bot.py --login
```

Firebase creds na hon to server **local JSON store** (`/tmp/shd_local_store.json`)
par chalta hai — testing ke liye theek, production ke liye nahi.

---

## 4 · Deploy

### 4a · Render (recommended, free)

`render.yaml` blueprint hai — repo connect karte hi dono services ban jaati hain.

**Site** (`studyhelper-site`)
- Build `npm ci --omit=dev` · Start `node server.js` · Health `/api/health`
- `PORT` Render deta hai (manual set na karein), `HOST=0.0.0.0`

**Bot** (`studyhelper-bot`)
- Build `pip install -r bot/requirements.txt` · Start `python bot/bot.py` · Health `/healthz`
- **numInstances: 1** (ek session do process par chale to `AUTH_KEY_DUPLICATED`)
- Free web service ~15 min idle par so jaati hai → koi external pinger
  (UptimeRobot / cron-job) `/healthz` har 10 min hit kare

**Zaroori env (dono me):**
`ADMIN_SESSION_SECRET` **bilkul same** — warna website ke banaye encrypted token
bot decrypt nahi kar payega.

Bot: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_BOT_TOKEN`, `TG_SESSION_STRING`
(**USER session — private channels se download isi se hota hai**), `FIREBASE_*`, `OWNER_TG_ID`.
Site: `FIREBASE_*`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TELEGRAM_BOT_USERNAME`.

> ⚠️ Website ko ab `TELEGRAM_API_ID/API_HASH/SESSION_STRING` ki zaroorat **nahi** —
> scanning aur delivery sirf bot karta hai.

### 4b · Vercel (agar purana domain wahin hai)

Repo ab **Vercel par bhi** deploy hota hai — `vercel.json` + `api/index.js` (3-line
wrapper jo wahi Express app ko serverless function ke roop me export karta hai).

- **Static layer**: `index.html` (root) + `site/*` Vercel ke CDN se seedha serve hote
  hain. Assets `/site/style.css` jaise paths par hain (local express bhi wahi serve
  karta hai, isliye dono jagah same build chalta hai).
- **API layer**: `/api/*` → `api/index.js` (Express + Firebase RTDB).
- **Secrets**: Vercel dashboard me wahi vars — `FIREBASE_*`, `ADMIN_SESSION_SECRET`,
  `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TELEGRAM_BOT_USERNAME`.
- **Raw files protected**: `/data/*`, `/server.js`, `/bot/*`, `package*.json`,
  `render.yaml`, `database.rules.json` → rewrite se 403 (`api/deny.js`).
- Dashboard me framework: **Other / None** (koi build command zaroori nahi).

> Bot **hamesha Render par** chalega (Vercel par 24×7 daemon possible nahi). Site
> Vercel par ho ya Render par — dono ek hi Firebase RTDB se judte hain, isliye
> `ADMIN_SESSION_SECRET` har jagah **same** rakhiye.

---

## 5 · Admin panel (8 tabs)

| Tab | Kya karta hai |
| --- | --- |
| **Overview** | courses, videos, requests (aaj ke), students, bot heartbeat |
| **Courses** | naya DB-only course, edit (name/thumb/price/hidden), hide/delete |
| **Explorer** | course ka tree → har lecture par **Add by URL** (Telegram post link) |
| **Telegram** | group scan task, registered groups, delivery requests, **purge danger-zone** |
| **Bot** | daily limit, IST reset hour, auto-delete, delivery mode, join-gate, pause, users |
| **Settings** | app name, telegram URLs, credit/contact, limits, maintenance mode |
| **Accounts** | student create/disable/delete + password reset |
| **Logins** | login + activity logs, filter ke saath |

**Add by URL** — Telegram post link paste kijiye (`https://t.me/channel/1234` ya
`https://t.me/c/1234567890/1234`):
1. link validate hota hai (public/private pehchaan ke saath)
2. chatId + messageId **encrypt** hoke node par attach (`tg_video_token`)
3. delivery automatically decide hoti hai — public → forward, private → download+upload

**Purge (danger zone)** — sirf Telegram-sourced additions:
`stripLinks` (default), `deleteTelegramNodes`, `deleteTelegramCourses`,
`clearGroupRegistry`, `clearRequests`, `clearEmbeds`, `clearBotState`.
File-backed courses, YouTube links, bot config, student accounts aur site settings
**kabhi** delete nahi hote. Preview button se pehle dekh sakte hain; chalane ke liye
`PURGE` type karna zaroori hai.

---

## 6 · Anti-theft gate (`POST /api/tg/request`)

1. login (401 `LOGIN_REQUIRED`)
2. per-user rate limit — 15 / 10 min (429 `RATE_LIMITED`)
3. **reuse** — isi lecture ki request pehle se active hai to wahi deep link
   (naya record nahi banta, isliye yeh cap-checks se pehle hai)
4. per-IP rate limit — 30 / 10 min (429 `IP_RATE_LIMITED`)
5. global daily breaker — `globalDailyLimit` 500 (503 `GLOBAL_LIMIT`)
6. **daily limit 20 / user** — IST midnight reset (429 `DAILY_LIMIT`)
7. pending cap — `maxPendingPerUser` 3 (429 `TOO_MANY_PENDING`)
8. node par encrypted `tg_video_token` na ho → 409 `NO_SOURCE` / `YOUTUBE_ONLY`
   ("not available on Telegram yet, will be uploaded soon")

Request record me plaintext chatId/messageId jaata hai (bot ke liye), website par
kabhi nahi dikhta. Bot side par: request **pehli baar kholne wale Telegram id se
bind** ho jaati hai (`boundTgUid`), `requestReuseLimit` (default 1) ke baad mar
jaati hai, aur TTL 168 ghante.

---

## 7 · Self-test (dono taraf)

```bash
# server: crypto, post-link parsing, IST quota window, overlay merge, sessions
node server.js --selftest        # 51 checks

# bot: vault, quota, delivery-mode, matcher rules, join-gate, health server
.venv-bot/bin/python bot/bot.py --selftest   # 91 checks
```

Dono self-test **bina Telegram/Firebase credentials ke** chalte hain — pure offline
logic. CI ya deploy se pehle chala lijiye:

```bash
node server.js --selftest && .venv-bot/bin/python bot/bot.py --selftest
```

> 🔐 Website aur bot ka crypto contract byte-compatible hai (`v1.` vault cipher aur
> `tg_` media token). Isliye `ADMIN_SESSION_SECRET` dono service me **bilkul same**
> hona chahiye — warna bot website ke banaye token decrypt nahi kar payega.
