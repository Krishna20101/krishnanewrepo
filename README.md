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
  bot.py                vault + store + matcher + 🧲 auto-scanner + health + bot — ek file
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

### 🧲 Auto-scan — "link site me kaun bharta hai?"

| Kaam | Kaun karta hai | Kab |
| --- | --- | --- |
| **Channel padhna (scan)** | 🤖 bot (`bot/bot.py`, USER session) | Admin → Telegram → **🧲 Start auto-scan**, ya bot ko `/scan` |
| **Match karna** | 🤖 bot | usi scan me — har media message vs `data/batches/*.json` ka har lecture |
| **URL/link site me bharna** | 🤖 bot khud (auto-scan) **ya** 🧑 admin (Explorer → Add by URL) | scan khatam hote hi Firebase overlay me token |
| **Video bhejna** | 🤖 bot | student ▶ → deep link → bot |

**Kaun se channels padhe jaate hain?** sirf `BOT_SCAN_CHATS` (Render → **bot** service
ka env). 10-15 ids comma/space separated — `@handle`, `-100xxxxxxxxxx`, ya invite link:

```
BOT_SCAN_CHATS=@disha_12th, -1001234567890, https://t.me/+AbCdEf
```

> Yahi list **delivery-search ko bhi limit** karti hai: student ki request par bot
> poore Telegram account ke dialogs nahi kholta, sirf inhi channels me dhoondhta hai
> (galat channel ki video match hone ka chance khatam + search fast).

**Match kaise hota hai** (wahi matcher jo delivery me chalta hai, threshold sirf zyada):

- lecture ka **title** (50-68%) + **folder/topic path** (18%) + **course ka naam** (32%)
- attach hone ke liye score ≥ `BOT_SCAN_MIN_SCORE` (default **75**; delivery threshold 60)
- **part guard** — `Part 3` kabhi `Part 4` se match nahi karta
- **course guard** — `12th मंजिल` vs `11th परिवर्तन` → reject (generic folder naam par nahi)
- 🇮🇳 **Devanagari** — `भाग ५` == `Part 5`, `क़` == `क` (digits + nukta normalize hote hain)
- VIDEO node par video hi attach hota hai, FILE/PDF node par document hi
- har channel ke `BOT_SCAN_MESSAGE_LIMIT` (default 400) recent messages padhe jaate hain

**Kya likha jaata hai:** admin ke "Add by URL" jaisa hi **minimal overlay** —
`custom_batches/<batchId>.tree` me sirf `{id, tg_video_token|tg_pdf_token, tg_meta,
source: "telegram_scan"}`. `data/batches/*.json` **kabhi modify nahi hoti** aur naya
lecture node **kabhi nahi banta** (jo JSON me nahi hai, wo attach nahi hota).

**Ek message = ek lecture.** Same video do lectures par na chali jaaye, isliye sabse
high score wala lecture jeet-ta hai; baaki unmatched count report me dikhta hai.

**Idempotent.** Dobara scan par pehle se attached lectures skip hote hain aur token
bilkul wahi rehta hai (deterministic IV) — students ke purane deep links zinda rehte hain.

**Scan ke baad student ▶ dabata hai** → request record me `chatId + messageId` pehle se
hota hai → bot ko **direct hit** milta hai (channel dobara search nahi hota) → video turant.

**Report kahan:** Admin → Telegram tab me *Scanned channels* (media / attached / bina link /
last scan) + *Scan tasks* (status aur `attached=… matched=… unmatched=…`); bot ke
`/healthz` me `lastScan`; Render logs me `🧲 scan done in …`.

> ⚠️ Bot aur website me `ADMIN_SESSION_SECRET` **bilkul same** hona chahiye — warna
> bot ka banaya token website decrypt nahi kar payegi aur attach hoga hi nahi.
> Token lifetime default **0 = kabhi expire nahi** (`TG_MEDIA_TOKEN_TTL_DAYS`, dono side same).

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
(**USER session — private channels se download isi se hota hai**), `FIREBASE_*`, `OWNER_TG_ID`,
aur 🧲 **`BOT_SCAN_CHATS`** (kaun se channels scan/search karne hain — 10-15 ids, comma
separated) + optional `BOT_SCAN_MIN_SCORE=75`, `BOT_SCAN_MESSAGE_LIMIT=400`,
`TG_MEDIA_TOKEN_TTL_DAYS=0`.
Site: `FIREBASE_*`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TELEGRAM_BOT_USERNAME`
(+ `TG_MEDIA_TOKEN_TTL_DAYS=0` — bot wali same value).

> ⚠️ Website ko ab `TELEGRAM_API_ID/API_HASH/SESSION_STRING` ki zaroorat **nahi** —
> scanning aur delivery sirf bot karta hai. **Vercel me session kabhi mat daliye.**

**🔑 Bot credentials kis order me uthte hain** (`resolve_credentials`):

1. **env vars** — `TG_SESSION_STRING`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_BOT_TOKEN`
2. **Firebase vault** — `telegram_vault/encrypted_creds` (encrypted; `ADMIN_SESSION_SECRET`
   se khulta hai). Purane website-panel se save kiye apiId/apiHash/botToken/sessionString
   yahin pade hain → Render me Telegram secrets na bhi do to bot vault se utha lega.
3. **interactive** — kuch missing ho to bot saaf likh deta hai kya chahiye.

Startup par log me dikhta hai kaunsa source use hua:
`user session : env:TG_SESSION_STRING` ya `vault (telethon format)` ya
`vault (converted from GramJS)`.

> ⚠️ Purani vault wali session **GramJS** format me hai — bot use Telethon me convert
> karta hai (best-effort). Sabse saaf rasta: ek baar `python bot/bot.py --login`
> chala kar **nayi Telethon session** banaiye aur wahi `TG_SESSION_STRING` me daliye.
>
> ⚠️ **EK session = EK process.** Jo bhi session chale, wo sirf Render ke ek instance
> me chale (numInstances: 1) aur koi purana runner/band deployment use use na kar
> raha ho — warna Telegram `406 AUTH_KEY_DUPLICATED` de kar session terminate kar deta hai.

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
  (Settings → General → Framework Preset = **Other**; Build Command khali chhodiye —
  Vercel function ke dependencies khud install kar leta hai.)

**Secrets checklist (Vercel):**

| Status | Variable |
| --- | --- |
| ✅ zaroori (8) | `FIREBASE_PROJECT_ID` `FIREBASE_CLIENT_EMAIL` `FIREBASE_PRIVATE_KEY` `FIREBASE_DATABASE_URL` `ADMIN_SESSION_SECRET` `ADMIN_EMAIL` `ADMIN_PASSWORD` |
| ➕ add karo (1) | `TELEGRAM_BOT_USERNAME` (bina `@` ke; na do to site bot online hote hi `bot_state/config` se khud utha leti hai) |
| 🗑 delete karo | `NEXT_PUBLIC_SITE_URL`, `TELEGRAM_JOIN_URL`, koi bhi `NEXT_PUBLIC_*`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_STRING`/`TG_SESSION_STRING`, `CLOUDFLARE_STREAM_WORKER_URL` — website ko inki zaroorat nahi, rakhna sirf leak hai |
| ⚙️ optional | `TG_MEDIA_TOKEN_TTL_DAYS=30`, `CORS_ALLOWED_ORIGINS` |

> Env badalne ke baad **Redeploy** zaroori hai — purani deployment purane values par
> chalti rehti hai (Vercel env list me ⚠️ isi ka ishara hota hai). `FIREBASE_PRIVATE_KEY`
> ek baar khol kar dekh lijiye: poora key ho (`-----BEGIN PRIVATE KEY-----` se shuru,
> `-----END PRIVATE KEY-----` tak; newlines `\n` likhe hon to bhi chalega).

> Bot **hamesha Render par** chalega (Vercel par 24×7 daemon possible nahi). Site
> Vercel par ho ya Render par — dono ek hi Firebase RTDB se judte hain, isliye
> `ADMIN_SESSION_SECRET` har jagah **same** rakhiye.

### 4c · 🔥 Firebase rules publish karna

Website aur bot **dono Firebase Admin SDK** use karte hain — Admin SDK rules se
parhai hoti hai. Browser/app se koi direct RTDB access nahi hai, isliye rules
**poora lock** rehte hain (repo me `database.rules.json` bhi yahi hai):

```json
{
  "rules": {
    ".read": false,
    ".write": false
  }
}
```

Publish kaise karein:
1. Firebase Console → **Realtime Database** → **Rules** tab
2. Upar wala JSON paste karo → **Publish**
   (ya CLI se: `firebase deploy --only database`)
3. Bas — iske baad koi bhi client-side read/write reject hogi; site aur bot
   (Admin SDK) bina ruke chalte rahenge.

> Agar kabhi rules me kholna pade to sirf server ke through kholein (naya API route),
> rules me `.read: true` **kabhi mat** kijiye — course data login ke peeche hai.

---

## 5 · Admin panel (8 tabs)

| Tab | Kya karta hai |
| --- | --- |
| **Overview** | courses, videos, requests (aaj ke), students, bot heartbeat |
| **Courses** | naya DB-only course, edit (name/thumb/price/hidden), hide/delete |
| **Explorer** | course ka tree → har lecture par **Add by URL** (Telegram post link) |
| **Telegram** | 🧲 **auto-scan** (channel → links attach), scanned channels, scan tasks, delivery requests, **purge danger-zone** |
| **Bot** | daily limit, IST reset hour, auto-delete, delivery mode, join-gate, pause, users |
| **Settings** | app name, telegram URLs, credit/contact, limits, maintenance mode |
| **Accounts** | student create/disable/delete + password reset |
| **Logins** | login + activity logs, filter ke saath |

**Add by URL** — Telegram post link paste kijiye (`https://t.me/channel/1234` ya
`https://t.me/c/1234567890/1234`):
1. link validate hota hai (public/private pehchaan ke saath)
2. chatId + messageId **encrypt** hoke node par attach (`tg_video_token`)
3. delivery automatically decide hoti hai — public → forward, private → download+upload

**🧲 Auto-scan** isi ka bulk version hai — ek channel paste karne ki jagah bot poora
channel padh kar saare matching lectures par link khud attach kar deta hai. Telegram
tab me teeno field khaali chhod kar button dabaiye → bot `BOT_SCAN_CHATS` (env) wale
saare channels scan karega; ek channel/course dena ho to wahi field bhar dijiye.
Nateeja *Scanned channels* + *Scan tasks* me dikhta hai (details: §2 · Auto-scan).

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
node server.js --selftest        # 53 checks

# bot: vault, media-token, quota, delivery-mode, matcher rules, 🧲 auto-scan
#      (course loader + overlay + poora pipeline nakli channel ke saath), join-gate, health
.venv-bot/bin/python bot/bot.py --selftest   # 198 checks
```

Dono self-test **bina Telegram/Firebase credentials ke** chalte hain — pure offline
logic. CI ya deploy se pehle chala lijiye:

```bash
node server.js --selftest && .venv-bot/bin/python bot/bot.py --selftest
```

> 🔐 Website aur bot ka crypto contract byte-compatible hai (`v1.` vault cipher aur
> `tg_` media token). Isliye `ADMIN_SESSION_SECRET` dono service me **bilkul same**
> hona chahiye — warna bot website ke banaye token decrypt nahi kar payega.
