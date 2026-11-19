# 🧠 MASTER PROMPT — "Study helper Doc" (Telegram-Bot-Only Edition)

> **Is file ko copy karke kisi bhi AI coder ko dein.** Ye prompt A-to-Z self-contained hai:
> product kya hai, kaise dikhta hai, data kaise stored hai, bot kaise kaam karta hai,
> admin kya-kya kar sakta hai, security kya hai, deploy kaise hota hai, aur kya-kya
> **bilkul nahi banana hai**. Isme diye gaye numbers/formats/rules ko *exactly* follow karna hai.

---

## 0. ROLE & MISSION

Tum ek senior full-stack engineer ho. Tumhe **"Study helper Doc"** naam ka ek
**mobile-first study portal** banana/maintain karna hai jisme:

- Students login karke apne **courses (batches)** dekhte hain → chapters → lectures.
- **Koi video website par play NAHI hoti.** Har lecture ke liye ek
  **"▶ OPEN IN TELEGRAM"** button hota hai. Ek **Telegram bot** wo video dhoondh kar
  student ki **private Telegram chat** me bhejta hai (clean re-upload, apna caption),
  kuch ghante baad auto-delete kar deta hai.
- **Bot hi Telegram groups scan karta hai** aur course ka **JSON** khud bhar deta hai
  (website sirf padhti hai).
- Ek **Admin Panel** hai jisse owner sab kuch phone se control karta hai.

**Deliverable:** Vercel par website + Render (free) par bot. Dono **Firebase Realtime
Database** se baat karte hain. Cost: ₹0.

---

## 1. ⛔ HARD RULES (ye todna hi nahi)

### 1.1 Jo cheezein BILKUL nahi honi chahiye (purane version se hata di gayi hain)

| ❌ Remove | Kyun |
|---|---|
| In-app video player (`<video>`, HLS, SmartVideoPlayer, gap-jump, stall-watchdog) | Video sirf Telegram se milti hai |
| **YouTube `<iframe>` embed playback**, "Switch Server", `playerSource` | YouTube-only lectures par sirf English "content unavailable" card |
| **Cloudflare Worker** (`cloudflare-worker/worker.js`), edge streaming, range requests | Koi streaming hi nahi |
| `/api/tg/stream/[token]`, `/api/tg/thumb/[token]`, chunked 32MB responses | Koi streaming/thumbnail proxy nahi |
| Website ke andar **GramJS / Telethon** session (`TELEGRAM_SESSION_STRING` on Vercel) | Telegram ka saara kaam **bot** karta hai → `406 AUTH_KEY_DUPLICATED` kabhi nahi aayega |
| Offline vault / "Save Offline" / IndexedDB blob download | Video phone me download nahi hoti |
| pdf.js in-app PDF viewer (`pdfjs-dist`) | Notes PDF bhi **bot** se aati hai (chat me file) |
| `forceBrowserPlayer`, `videoDeliveryMode: "in-app-player"`, `CLOUDFLARE_STREAM_WORKER_URL` | Delivery mode ek hi hai: Telegram bot |
| Wishlist page + bottom dock | v4 me hata diya gaya (purana `/wishlist` link `/` par redirect) |

Agar koi in cheezon ka code mile → **delete karo**, "keep for fallback" mat karo.

### 1.2 Jo cheezein HAMESHA honi chahiye

1. **Saara user-facing text ENGLISH me.** (Code comments Hinglish me likh sakte ho.)
   Koi Hindi/Devanagari string UI, bot messages, captions ya error messages me nahi.
2. **Source channel/group ki pehchaan kabhi leak na ho** — na caption me, na file name me,
   na `@username`, na "Forwarded from". `clean` mode me file download karke **fresh upload**
   hoti hai apne caption ke saath.
3. **Bot ke saare messages me har failure surface ho** — kuch bhi silently hang na kare.
4. **Real uploaded data kabhi destroy na ho**: `data/batches/*.json` files read-only seed
   hain. Purge/delete operations **DB-only overrides** likhein, file-backed courses ko
   physically delete na karein.
5. **Phone-first**: har screen 360px width par perfect; sticky header; bade tap targets
   (min 44px); `select-none` + right-click/copy/DevTools block (client deterrent);
   koi hover-only affordance nahi.
6. **Secrets kabhi client bundle me nahi** — `NEXT_PUBLIC_*` ke alawa kuch bhi browser tak nahi.

---

## 2. 📁 FILE STRUCTURE — **KAM SE KAM FILES** (ye sabse important requirement hai)

Purane version me **86 files / 27,700 lines** ho gayi thi. Naya target:
**~19 files**. Ek hi jagah sab kuch, duplicate nahi.

```
studyhelperdoc/
├─ package.json                  # deps: next, react, firebase-admin, tailwind, lucide-react
├─ next.config.mjs               # security headers, images.remotePatterns, reactStrictMode
├─ tsconfig.json                 # "target": "ES2017", strict, paths "@/*" -> "src/*"
├─ postcss.config.mjs
├─ tailwind.config.ts            # v4 theme tokens (ink/ember/sage/sand) + fonts + radii
├─ render.yaml                   # bot ka Render blueprint (free Web Service)
├─ .env.example                  # Vercel + bot dono ke vars, comments ke saath
├─ README.md                     # setup + deploy (A-to-Z, Hinglish)
├─ MASTER_PROMPT.md              # ye file
├─ database.rules.json           # RTDB rules
├─ data/
│  └─ batches/*.json             # course seed data (owner ki real files — read-only)
├─ public/icon.svg
├─ src/
│  ├─ lib/
│  │  └─ site.ts                 # ⭐ EK HI SERVER FILE — sab kuch isi me (niche §6)
│  └─ app/
│     ├─ layout.tsx              # root layout: fonts, theme, ContentGuard (inline component)
│     ├─ globals.css             # poora v4 theme (tokens + .btn-ember/.surface/.chip …)
│     ├─ page.tsx                # HOME: login gate + course grid + search
│     ├─ batch/[batchId]/page.tsx       # COURSE: Lectures | Notes (segmented tabs)
│     ├─ watch/[batchId]/[videoId]/page.tsx  # ⭐ BOT DELIVERY CARD (koi player nahi)
│     ├─ wishlist/page.tsx       # 6 lines: `/` par redirect (purane links ke liye)
│     ├─ admin/page.tsx          # ⭐ EK HI ADMIN FILE — saare 8 tabs isi me
│     └─ api/[...path]/route.ts  # ⭐ EK HI API ROUTER — saare endpoints (switch/case)
└─ telegram-bot/
   ├─ bot.py                     # ⭐ EK HI BOT FILE — sab kuch (niche §8)
   └─ requirements.txt           # Telethon, cryptography, firebase-admin, requests, python-dotenv
```

**Rules:**
- `src/lib/site.ts` = server-side ka **single source of truth**. Isse 3+ files me mat todo.
  (Agar zaroorat pade to maximum 2: `site.ts` + `siteAdmin.ts` — usse zyada nahi.)
- `src/app/api/[...path]/route.ts` = **catch-all router**. Har endpoint ek `case` hai.
  Alag-alag `route.ts` folders mat banao.
- Components alag file me mat nikalo — page ke andar hi local component banao
  (`function CourseCard(){}`), jab tak 2+ pages use na karte hon.
- `telegram-bot/bot.py` = **ek file**: vault + store + matcher + scanner + delivery +
  join-gate + anti-theft + health server + CLI + selftest. Alag `.py` modules mat banao.
- Naya file banane se pehle socho: kya ye existing file me section ban sakta hai? **Haan → wahi karo.**

---

## 3. 🛠 TECH STACK

| Layer | Choice |
|---|---|
| Framework | **Next.js 14.2.x (App Router) + TypeScript + strict** |
| Styling | **Tailwind CSS 3.4** (v4 theme tokens) — koi UI kit nahi |
| Icons | `lucide-react` |
| DB / state | **Firebase Realtime Database** (`firebase-admin` server-side only) |
| Local fallback | `data/local_store.json` (+ `/tmp/shd_local_store.json` dev override) |
| Bot | **Python 3.11 + Telethon 1.45** (user session + bot token) |
| Hosting | Website → **Vercel** (Hobby) · Bot → **Render free Web Service** |
| Tests | Offline self-test CLI (`python bot.py --selftest`) + `tsc --noEmit` + `next build` |
| **Nahi chahiye** | ESLint/Prettier config, CI, jest, pdfjs-dist, telegram (GramJS), express |

---

## 4. 🎨 LOOK & FEEL — theme **"v4 Slate & Ember"**

Neon cyberpunk **band**. Naya look: deep ink-navy canvas + warm copper/ember accent +
soft sand text + serif display headings. **Koi glow nahi, koi cyber-grid nahi, koi glass
blur nahi** — flat layered surfaces, hairline borders, notebook jaise asymmetric corners.

### 4.1 Design tokens (tailwind.config.ts `theme.extend`)

```
colors:
  ink:   950 #08090f · 900 #0c0e17 · 850 #11131e · 800 #181b28 · 700 #222737
  ember: 300 #f9c8a0 · 400 #f0a06a · 500 #de7a43 · 600 #bc5f2d · 700 #8e4520
  sage:  300 #a7d6c5 · 400 #7cbaa4 · 500 #55917c        (success / secondary)
  sand:  100 #f5f1e8 · 200 #e2dcd0 · 300 #c3bcae · 400 #96907f · 500 #6f6959
fontFamily: display → var(--font-display), Georgia, serif   |  body → system-ui
borderRadius: card 1.35rem · tag 0.5rem
boxShadow: lift · lift-sm · ember (soft paper-depth, no neon)
keyframes: riseIn, sweep, breathe, tiltIn   (subtle, 200-400ms)
```

### 4.2 CSS utility classes (globals.css me define karo)

`.bg-canvas` (ink-950 + subtle vertical gradient), `.bg-grain` (SVG noise, 3% opacity),
`.surface` (layered panel + `--hairline` border), `.surface-raised`, `.btn-ember`
(copper gradient, dark text `#1a0d05`, weight 800), `.btn-ghost` (hairline border),
`.chip` / `.chip-ember` / `.chip-sage`, `.font-display`, `.rule` (thin divider),
`.perf-card-item` (transform/opacity only — no layout thrash).
Print CSS: `@media print { body { display: none } }` + `NEXT_PUBLIC_DISABLE_CONTENT_GUARD=1`
se guard band hone ka option.

### 4.3 ContentGuard (client deterrent — layout me mount)

Right-click/long-press block, copy/cut block (password fields exempt), drag block,
DevTools shortcuts intercept (F12, Ctrl/Cmd+Shift+I/J/C, Ctrl+U, Ctrl+S), Ctrl+P block.
UI me honest note: *"client-side guard 100% unbreakable nahi hota — asli protection
server-side hai (signed sessions, single-use links, Telegram-only delivery)."*

### 4.4 Screens

| Screen | Kya dikhta hai |
|---|---|
| **Home `/`** | Header: logo + app name + tagline · right corner: **Downloads nahi** (hata diya), Telegram icon (sirf jab real channel link configured ho), Sign out. Niche: search field (plain) + **course grid**. Course tile: flat `.surface`, left **ember rail**, corner index number, thumbnail (course-level), name (serif), hairline meta row (price chip · lectures count · "TOP" tag agar important), arrow affordance. Loading/empty states English me. |
| **Course `/batch/[id]`** | Sticky header + back button, course hero, **segmented switch: `LECTURES` \| `NOTES`** (ember underline). Lectures = list-style rows (chapter → lecture, index number, size, ▶ tap → watch). Notes = document-style rows (PDF icon, title, size → tap = **bot se PDF mangta hai**). TEST/LIVE tabs **nahi** hain. |
| **Watch `/watch/[batchId]/[videoId]`** | **Koi player nahi.** Poora stage = **Telegram Delivery Card** (§7). Niche: lecture details card (course · chapter · title · uploaded date) + "More Lectures in <chapter>" grid. Agar lecture ka Telegram source nahi hai → **English card**: badge `CONTENT UNAVAILABLE`, title `This Lecture Is Not Available Yet`, body `This content is unavailable right now. It will be uploaded soon — please check back later.` |
| **Login gate** | Bina login har student screen par `LoginGateCard`: email / mobile / user ID + password. **Pehli baar login = auto signup** (koi registration form nahi). Notice: `Account created — welcome aboard.` |
| **`/wishlist`** | Sirf `router.replace("/")` (purane bookmarks ke liye). |
| **Admin `/admin`** | §9 dekho. |

---

## 5. 🗂 DATA MODEL

### 5.1 Course (batch) JSON — `data/batches/<slug>_<id>.json`

Ye **seed data** hai (owner ki asli courses). Real example:

```jsonc
{
  "source": "telegram_auto_sync",        // ya "disha_bat_scrape" / "manual"
  "id": "58",
  "name": "11th Commerce - Parivartan Batch (2026-2027)",
  "thumbnail": "https://…/cover.jpg",     // course-level only (video thumbs nahi)
  "price": 999,                           // sirf DISPLAY — access sabko free (flag se badalta hai)
  "slug": "11th-commerce-parivartan-2027",
  "scraped_at": "2026-03-01T10:00:00Z",
  "item_count": 8,
  "tree": [
    {
      "id": "201001", "parent_id": null,
      "title": "Accountancy - 2027", "type": "FOLDER",
      "thumbnail": "", "videos_count": 2, "files_count": 1,
      "children": [
        { "id": "201002", "parent_id": "201001", "title": "Chapter 1 - Introduction to Accounting",
          "type": "FOLDER", "videos_count": 2, "files_count": 0,
          "children": [
            {
              "id": "201003", "parent_id": "201002",
              "title": "Accountancy Complete Syllabus & Basics L-1",
              "type": "VIDEO",
              "uploaded_at": "01-03-2026 at 05:00 pm",
              "file_size": 184549376,
              "tg_video_token": "v1.<b64url-iv>.<b64url-tag>.<b64url-ciphertext>",
              "tg_pdf_token": "v1.…",              // optional: attached notes
              "pdf_link_enc": "tg_attached",       // marker: PDF Telegram se aayegi
              "youtube_url": ""                    // ⚠️ sirf metadata — playback kabhi nahi
            }
          ]
        }
      ]
    }
  ]
}
```

**Node types:** `FOLDER` | `VIDEO` | `PDF` | `LINK`.
**Sync se bane node ids:** video → `tgv_<messageId>`, pdf → `tgp_<messageId>`.
**Sync marker:** course level par `"source": "telegram_auto_sync"`.
**`tg_video_token` / `tg_pdf_token`** = AES-256-GCM encrypted blob jisme
`{c: chatId, m: messageId, s: size, n: fileName, t: title}` hota hai
(format `v1.<iv>.<tag>.<ct>`, scrypt-derived key, label `shd_tg_media_vault_v3_2026`).
Ye token **bot** decrypt karta hai — website sirf pass-through karti hai.

### 5.2 Firebase RTDB layout (website + bot ka shared brain)

```
custom_batches/<batchId>        # bot/admin se bane ya override kiye courses (file seed par jeetta hai)
deleted_batch_ids/<batchId>     # true → course list se hat jata hai (file delete nahi hoti)
batch_meta/<batchId>            # displayPrice, important, thumbnail override, hidden
video_embeds/<batchId>__<videoId>   # {rawUrl, embedUrl, youtubeId}  (rawUrl "" = delete)
telegram_groups/<key>           # scanned group registry (chatId, title, lastSync, counts)
tg_requests/<requestId>         # ⭐ delivery request (niche §7.2)
bot_state/
  config                        # ⭐ bot ke saare knobs (§8.4) — website edit karti hai, bot padhta hai
  heartbeat                     # {at, bot, user, backend} → admin panel ONLINE/OFFLINE
  users/<tgUid>                 # {username, first_name, deliveries[], videosLast24h, banned, dailyLimit}
  deletions/<key>               # restart-safe auto-delete queue {uid, messageId, dueAt}
  tasks/<taskId>                # website → bot commands (scan_group, broadcast, save_config, …)
  events/<ts>                   # last 400 events (audit + debugging)
  stats                         # {videosLast24h, deliveredTotal, blocked_*}
site_settings                   # appName, tagline, logo, announcement, telegramJoinUrl, popup, …
student_accounts/<safeKey>      # {name, email, phone, passwordHash(scrypt), salt, isPaidUser, createdAt}
user_logins/<ts>                # login history (password kabhi store nahi)
local_paths/…                   # rate_limits/, admin_logs/, web_quota/, tg_request_ip/ …
```

### 5.3 `tg_requests/<requestId>` record

```jsonc
{
  "uid": "student@example.com",        // kis login ne banayi
  "batchId": "58", "batchName": "…", "videoId": "201003",
  "title": "Accountancy Complete Syllabus & Basics L-1",
  "topic": "Accountancy - 2027 › Chapter 1 - Introduction to Accounting",
  "courseName": "11th Commerce - Parivartan Batch",
  "folderPath": ["Accountancy - 2027", "Chapter 1 - …"],
  "chatId": "-100123…", "messageId": 4567,       // bot yahan se file uthata hai
  "fileName": "Lecture 1.mp4", "fileSize": 184549376, "mimeType": "video/mp4",
  "kind": "VIDEO",                                // ya "PDF"
  "part": null,
  "youtubeUrl": "",                               // set hai + chatId nahi → NO_SOURCE
  "deepLink": "https://t.me/<bot>?start=<requestId>",
  "createdAt": 1795000000000, "expiresAt": 1795600000000,
  "status": "pending",                            // pending | delivered | failed | expired
  "usedCount": 0, "boundTgUid": 0, "ip": "1.2.3.4"
}
```

---

## 6. 🧩 `src/lib/site.ts` — EK FILE ME SAB KUCH

Sections (isi order me, har section par comment banner):

1. **env & secrets** — `cleanEnv()`, `serverSecrets`: production me `ADMIN_SESSION_SECRET`
   missing ho to **503** (silent fallback key kabhi nahi). Master key =
   `scrypt(ADMIN_SESSION_SECRET || ADMIN_EMAIL:ADMIN_PASSWORD:FIREBASE_PROJECT_ID, salt, 32)`.
2. **Firebase RTDB** — `firebase-admin` init, `rtGet/rtSet/rtRemove/rtChildren`,
   `safeRtdbKey()`, `invalidateServerCaches()`.
3. **local store** — `readLocalStore/writeLocalStore`
   (`/tmp/shd_local_store.json` pehle, fir `data/local_store.json`; dono me likho).
4. **rate limiting (DB-backed)** — `rateLimitHit(bucket, key, {windowMs, max, lockMs})`.
   In-memory Map **mat** use karo (Vercel ke har container me alag ginti chalti hai).
5. **crypto** — media-token vault (`v1.<iv>.<tag>.<ct>`), HMAC helpers, session sign/verify
   (`exp` claim zaroori), scrypt password hash/verify.
6. **auth** — `loginOrRegisterStudent()` (first login = signup), `isContentRequestAuthorized()`,
   admin login + 5-fail lock (300s) + `admin_logs`.
7. **batch engine** — `loadAllRawBatches()` (files → RTDB overrides → `deleted_batch_ids` skip),
   `loadSingleRawBatch()`, `getEffectiveRootNodes()`, `findVideoInBatch()` →
   `{video, folderTitle, folderPath, siblings}`, `toCleanNodeItem()` (tokens strip karke
   sirf zaroori fields bhejo; `tg_video_token` watch API me **allowed** hai kyunki wo
   server-side hi rehta hai — client par kabhi nahi), `isFreeTag()`.
8. **delivery** — `getBotConfig()` (+`DEFAULT_BOT_CONFIG`), `createTelegramRequest()`,
   `findReusableRequest()`, `countPendingRequests()`, `getWebRequestQuota()`,
   `consumeWebRequestQuota()`, `getGlobalDeliveryQuota()`, `cleanupExpiredRequests()`.
9. **bot tasks** — `pushBotTask({type,…})` → `bot_state/tasks` (scan_group, broadcast,
   save_config, set_user_limit, purge…).
10. **purge** — `previewTelegramPurge()` + `executeTelegramPurge()` + audit log (§9.8).
11. **site settings** — `getEffectiveSiteSettings()`, `saveCustomBatchDbOnly()`,
    `isFileBackedBatch()`, `deleteBatchCompletely()` (sirf non-file-backed par).

---

## 7. ⭐ WATCH PAGE = TELEGRAM DELIVERY (poora flow)

### 7.1 Page kya dikhata hai

`TelegramDeliveryCard` (v4 styling: `.surface` panels, `.btn-ember` CTA, `.chip` meta):

- Phone mockup tap-target + primary CTA **"▶ Open in Telegram"**
- Status line: `Creating link…` → `Telegram opened. The bot is searching your lecture now.`
- Deep link row: `https://t.me/<bot>?start=<id>` + **Copy** + **Open** buttons
- **Quota badge:** `9 of 12 videos left today` / `Daily limit reached (12/12)` + `resets in 6h`
- Fair-use line: `Fair-use limit: 12 videos every 24 hours • each link works once, for your
  Telegram account only`
- Lecture meta: 📺 title · 📚 Topic: … · 🎓 Course: … · Size: 176 MB
- Info chips: daily limit + contact handle · auto-delete hours · `Extracted By @<credit>`
- How-it-works (3 steps, English)
- Error/notice boxes (rose = error, ember = warning, sage = success)
- **Koi "Play in browser" fallback nahi**, koi player nahi, koi iframe nahi.

### 7.2 `POST /api/tg/request` — 8 layers (isi order me)

| # | Check | Fail par |
|---|---|---|
| 1 | Student logged in? | `401` |
| 2 | Per-login throttle `tg_request:<uid>` = **15 / 10 min** | `429 RATE_LIMITED` |
| 3 | Per-IP throttle `tg_request_ip` = **30 / 10 min** | `429 IP_RATE_LIMITED` |
| 4 | Global 24h breaker (`globalDailyLimit`, default **500**) | `503 GLOBAL_LIMIT` |
| 5 | Daily quota (`dailyLimit`, default **12** / 24h rolling) — English message me `contactUsername` | `429 DAILY_LIMIT` + `resetInSec` |
| 6 | Pending requests < `maxPendingPerUser` (default **3**) | `429 TOO_MANY_PENDING` |
| 7 | `findReusableRequest()` — same user+video within `requestCooldownMin` (default **5**) → **wahi link dobara** (`reused:true`, quota spend nahi) | — |
| 8 | Node me `tg_video_token`/`tg_pdf_token` hai? YouTube-only/nofile → | `409 NO_SOURCE` + English "content unavailable" |

Pass → request record banao (`tg_requests/<id>`), quota consume karo, expired requests
fire-and-forget cleanup, response: `{ok, requestId, deepLink, reused, quota:{used,limit,remaining,resetInSec}}`.

`GET /api/tg/request?id=<id>` → `401` / `400` (id regex `^[A-Za-z0-9_-]{4,40}$`) / `404` /
**`403` agar `record.uid !== uid`** (`This link belongs to another account.`).

### 7.3 Delivery card ka client behaviour

Tap → POST → deep link `window.open` → status `ready` → same video dobara tap karne par
`reused:true` notice. Quota khatam → card par hi English reason + reset time.

---

## 8. 🤖 `telegram-bot/bot.py` — EK FILE, POORA BOT

### 8.1 Kya-kya karta hai

1. **Scan & fill JSON** (admin task par) — groups/channels padhta hai, captions parse karta
   hai, course tree banata hai, media refs encrypt karke `custom_batches/<id>` me likhta hai.
2. **Deliver** — `?start=<requestId>` deep link par video/PDF dhoondh kar private chat me
   clean re-upload, caption fixed format, auto-delete.
3. **Guard** — join-gate, anti-theft, quota, ban, pause.
4. **Admin commands** + heartbeat + event log + restart-safe deletion queue.
5. **Health server** (Render free tier ke liye `PORT` bind).

### 8.2 Clients & credentials

- **BOT client** = `TELEGRAM_BOT_TOKEN` (student se baat, upload, delete).
- **USER client** = `TG_SESSION_STRING` — **bot ke liye ALAG session**
  (`python bot.py --login` se banao). Website wali session **kabhi share mat karo**
  (Telegram ek session do IP se khulne par maar deta hai).
- Credentials priority: **env → Firebase vault (encrypted) → error**. Vault se padhne ke liye
  `ADMIN_SESSION_SECRET` Vercel wali **exact same value** chahiye.
- Storage: **Firebase RTDB primary**, warna **SQLite fallback** (`bot_state.db`).

### 8.3 Caption parser + matcher (bot scan & delivery dono me use hota hai)

**Parser:** Hindi labels bhi samjhe (`टाइटल`, `बैच`, `विषय`), emoji/bullets,
`【Title】`, single-line `Title | Batch | Topic`, `Lecture Name =`, `Part 3/12`,
date formats, file size. Output: `{title, topic, course, part, date, size}`.

**Dedupe:** same title+size wale candidates ek ho jate hain.

**Scoring (exact formula):**
```
titleSim  = similarity(request.title, candidate.title)
topicSim  = similarity(request.topic, candidate.topic)      # topic na mile to title se ×0.6
courseSc  = course_match_score(request.courseName, candidate.course || chat_title)

if courseSc < COURSE_MIN (0.34):            → score 0 (reject)
score = 100 × (0.50·titleSim + 0.18·topicSim + 0.32·courseSc)
size ratio > 0.97  → +6      size ratio < 0.5 → −8      cap 0..100
accept if score ≥ MATCH_THRESHOLD (60.0)
similarity() = 0.50·Jaccard(tokens) + 0.28·Containment + 0.22·Bigram-Dice
```

**Search budget:** `BOT_SEARCH_BUDGET_SEC` (default 120s), `maxDialogs` 60,
`maxMessagesPerChat` 40, deep-scan sirf jab direct + search dono fail hon.

### 8.4 Delivery caption — **EXACT ORDER (user rule)**

```
📺 <Title>
📚 Topic: <Chapter / folder path>
🎓 Course: <Course name>

Extracted By @<creditUsername>
```
- Max 1000 chars (trim + `…`).
- **Sirf credit handle `@…` allowed** — baaki har `@username` caption se hata diya jata hai.
- Source chat ka naam, id, link, "Forwarded from" — kuch nahi.

### 8.5 Delivery modes

- **`clean` (default):** file download → **fresh upload** apne caption ke saath →
  source ka koi trace nahi. Slow par safe.
- **`forward`:** seedha forward (fast) — par original caption/source dikhta hai, isliye
  default nahi. Admin panel se switch.

### 8.6 Limits & guards (bot side)

| Guard | Default | Behaviour |
|---|---|---|
| Daily limit per Telegram user (rolling 24h) | **12** | English message + `resets in Xh` + `contactUsername` |
| Auto-delete delivered video | **2 h** | restart-safe queue (`bot_state/deletions`) |
| Global 24h circuit breaker | **500** | `🚦 Delivery is temporarily full for today…` |
| Link reuse | **1** (single-use) | `🔁 This link has already been used…` |
| Account binding | on | pehla kholne wala owner; dusre ko `🔐 This link belongs to another account.` |
| Request TTL | **168 h** | expired → English "link expired" |
| Max upload size | **2000 MB** (free Render par **300–700** rakho) | bigger → English "file too large" |
| Concurrency | `BOT_MAX_PARALLEL=1` (free tier) | queue position message |
| Ban / pause | `banned` flag, `paused` + `pauseMessage` | English |
| **🔒 Channel join-gate** | **OFF** | niche §8.7 |

**Order:** join-gate → anti-theft gate → daily quota → per-user lock → search → deliver.
Block hone par **link consume nahi hota, quota nahi katti.**

### 8.7 🔒 Channel join-gate

Config: `joinGateEnabled` (default **false**), `joinGateChannel` (`@username` ya `-100…`),
`joinGateInviteUrl` (khaali → `https://t.me/<username>`; private channel → `https://t.me/+…`).

- Membership check: `channels.GetParticipantRequest` — **pehle bot session, fail to user session**.
- Non-member → inline buttons **"📢 Join our channel"** (URL) + **"✅ I have joined"** (callback).
- Callback par live re-verify → member mila to pending request **turant deliver**.
- Confirmed members **10 min cache**.
- Check impossible ho (bot channel me admin nahi / channel private) → **FAIL-OPEN**
  (video chali jaye) + log + `join_gate_check_failed` event. Galat config ki saza student ko nahi.
- Events: `join_gate_block`, `join_gate_pass`.
- **Bot ko us channel me ADMIN banana zaroori hai.**
- Env override: `JOIN_GATE_CHANNEL`, `JOIN_GATE_INVITE_URL` (panel value jeetti hai).

### 8.8 🩺 Health server (Render free tier)

Free tier par Background Worker nahi milta → bot ko HTTP port bind karna padta hai
(stdlib `ThreadingHTTPServer`, daemon thread, **koi nayi dependency nahi**):

| Path | Behaviour |
|---|---|
| `/healthz`, `/health` | **hamesha 200** (process zinda) — Render health check yahi |
| `/ready` | bot sach me running ho tab 200, warna **503** + reason |
| `/`, `/status` | uptime, storage backend, botUsername, deliveryMode, limits, `videosLast24h`, join-gate state, queue depth — **koi secret nahi** |

- `PORT` (Render deta hai) ya `BOT_HEALTH_PORT` set ho tabhi chalta hai → local/VPS par
  koi port nahi khulta. `BOT_DISABLE_HEALTH=1` se off.
- `BOT_HEALTH_TOKEN` set ho to `/status` token maangta hai (`X-Bot-Token` ya `?token=`);
  `/healthz` public rehta hai (pinger ke liye).
- **Supervisor loop:** startup fail hone par process exit nahi karta — reason health payload
  me jata hai aur bot backoff ke saath retry karta hai (20s → 40s → … max 300s).
  `BOT_NO_RETRY=1` = purana one-shot behaviour.
- Health server **Telegram/Firebase connect se PEHLE** bind ho (warna Render deploy fail).

### 8.9 🔎 Scan → JSON bharna (admin task se)

`bot_state/tasks/<id>` = `{type:"scan_group", chatId|inviteLink, courseName, batchId?, maxMessages, mode}`

Bot:
1. Dialog/entity resolve karo (invite link ho to `ImportChatInviteRequest`).
2. Messages iterate karo (media + caption-only dono), parser se fields nikalo.
3. **Folder tree** banao: caption ke `Topic:`/`Batch:`/`Chapter` se, warna date/month se.
4. Har video ke liye `tg_video_token` (vault encrypt `{c,m,s,n,t}`), paired PDF ho to
   `tg_pdf_token` + `pdf_link_enc:"tg_attached"`.
5. Node ids `tgv_<messageId>` / `tgp_<messageId>`; course `source:"telegram_auto_sync"`.
6. Dedupe (title+size), progress task par likho (`scanned`, `matched`, `skipped`).
7. Result `custom_batches/<batchId>` me save + `telegram_groups/<key>` registry update +
   task `status:"done"` + event log.
8. **Website restart/redeploy ki zaroorat nahi** — site RTDB se live padhti hai.

Website side: admin panel sirf task push karta hai aur progress poll karta hai.
**Website ke paas Telegram credentials hone hi nahi chahiye.**

### 8.10 Bot commands (private chat)

| Command | Kaam |
|---|---|
| `/start <requestId>` | delivery shuru (deep link) |
| `/help` | English help (+ admin commands agar admin) |
| `/status`, `/mylimit` | quota + reset time |
| `/find <text>` | admin/user search (configurable) |
| **Admin only:** `/broadcast <msg>`, `/setlimit <uid> <n>`, `/levelup`, `/pause`, `/resume`, `/config`, `/stats`, `/purge` | website tasks ke barabar |

Admins = `OWNER_TG_ID` + `ADMIN_TG_IDS` + session owner (auto).

### 8.11 CLI

```
python bot.py                # run (health server + supervisor)
python bot.py --login        # ALAG user session banao (TG_SESSION_STRING print)
python bot.py --selftest     # offline tests (matcher, vault, store, quota, gates, health)
python bot.py --info         # creds/config/state summary
python bot.py --print-session
```
`--selftest` **bina network ke** chalta hai aur **green hona chahiye** (kam se kam 60 checks).

---

## 9. 🛡 ADMIN PANEL (`/admin` — EK FILE, 8 TABS)

Login: `ADMIN_EMAIL` + `ADMIN_PASSWORD` (ya `*_HASH` + `ADMIN_SALT`). Cookie
`shd_admin_token` (signed, expiring). 5 galat koshish → **429 lock 300s** (DB-backed).
Production me `ADMIN_SESSION_SECRET` missing → **503** (site hi refuse karti hai).
Mobile par pill-bar horizontal scroll, har tab me sticky action buttons.

| Tab | Kya kar sakta hai |
|---|---|
| **1. Folder & Video Tree (EXPLORER)** | Course kholo → chapter → lectures ka tree dekho/sudharo; node rename, move, hide, delete; manual video/PDF/LINK add; thumbnail + price + "TOP/important" flag; JSON preview. |
| **2. Telegram Sync Studio (TELEGRAM)** | Group/channel link ya id daalo → **scan task bot ko bhejo** → live progress (scanned/matched/skipped) → result course tree me merge/replace. Group registry (kitne groups, last sync). **Niche Danger Zone → Purge (§9.8).** |
| **3. Telegram Bot Delivery (BOT)** | Bot username, delivery mode (Telegram bot only), `clean/forward`, daily limit, auto-delete hours, credit + contact handle, pause/resume + pause message, max dialogs/messages, request TTL, **maxUploadMb**. Live: heartbeat (ONLINE/OFFLINE + ago), stats, users list (per-user limit set, ban, "Level up everyone"), broadcast, task queue, recent events. **Anti-theft & fair use card:** `globalDailyLimit` (+ live 24h usage badge `used/limit`, `breaker TRIPPED`), `requestReuseLimit`, `requestCooldownMin`, `maxPendingPerUser`. **Channel join gate card:** toggle + channel + invite URL (+ explanation ki bot ko ADMIN banana hai, fail-open behaviour). **Cloudflare Worker secret card: HATA DO** (worker hi nahi hai). |
| **4. All Courses (COURSES)** | Har course: lectures/folders/PDFs count, source (file/DB/manual/telegram), hidden toggle, delete (sirf DB-backed; file-backed par **protected** badge), open in tree. |
| **5. Analytics Overview (OVERVIEW)** | Total batches/videos/folders/PDFs, saved logins, active students, deliveries 24h, blocked reasons, sync stats, storage backend (RTDB/local). |
| **6. Website & .env Security (SETTINGS)** | App name, tagline, logo URL, default image, announcement (text + enable), Telegram join URL (+ popup title/subtitle/auto-close seconds/enable), CORS origins, media-token TTL days, **secret health check** (kaun se env set hain — value kabhi nahi dikhati), ContentGuard toggle. **Access sab logged-in students ke liye FREE hai** — `isPaidUser` sirf ek account flag hai, koi gating nahi. (Paid gating chahiye to naya flag `requirePaidAccess` add karo, default `false`.) **Ye purani keys hata do:** `cloudflareStreamWorkerUrl`, `allowVideoDownload`, `defaultYoutubeUrl`, `videoDeliveryMode` (ab delivery mode ek hi hai — Telegram bot). |
| **7. Accounts (ACCOUNTS)** | Student accounts: search, paid/free toggle, ban/unban, reset password, delete, last login. |
| **8. Login History (LOGINS)** | Kab, kaun, kahan se (id/email), success/fail — password kabhi store nahi. |

### 9.8 🧹 Purge (Danger Zone) — "saara Telegram data ek click me saaf"

`GET /api/admin/telegram/purge` = **preview** (kuch delete nahi karta),
`POST` = execute (`confirmText: "DELETE"` zaroori, warna reject).

**Options (checkbox):**
| Option | Kya karta hai | Default |
|---|---|---|
| `stripLinks` | nodes se `tg_video_token`/`tg_pdf_token`/`pdf_link_enc:"tg_attached"`/`tg_meta` hatao, structure rahe | ✅ ON |
| `deleteTelegramNodes` | `tgv_*`/`tgp_*`/`tg_*` + telegram media nodes delete | OFF |
| `deleteTelegramCourses` | sirf `source==="telegram_auto_sync"` **aur** non-file-backed courses | OFF |
| `clearGroupRegistry` | `telegram_groups/*` | ✅ ON |
| `clearRequests` | `tg_requests/*` | ✅ ON |
| `clearEmbeds` | `video_embeds` jinka `rawUrl` telegram-stream/tg_ ho | ✅ ON |
| `clearBotState` | `bot_state/{users,deletions,stats,tasks,events}` — **config kabhi nahi** | OFF |

**Hamesha protected (preview me count dikhao):** `fileBackedCourses`, `manualCourses`,
`youtubeLinks`, **bot config**, student accounts, site settings.
Stripped courses par `purgedTelegramAt` stamp + **DB-only override** (`saveCustomBatchDbOnly`)
— `data/batches/*.json` **kabhi modify nahi**. Audit log: `admin_logs/telegram_purge/<ts>`.

---

## 10. 🔐 SECURITY RULES

1. **Signed, expiring cookies** (`shd_student_token`, `shd_admin_token`) — HMAC + `exp`.
2. **Default-deny** guards: har student API par auth check; har admin API par admin check;
   CORS allow-list (`CORS_ALLOWED_ORIGINS`), `X-Content-Type-Options`, `Referrer-Policy`,
   `X-Robots-Tag` on internal endpoints.
3. **Rate limits DB-backed** (in-memory nahi): admin login 5/300s lock, student login throttle,
   request throttles §7.2.
4. **Secrets:** koi fallback key production me nahi (503 better than silent insecure).
   `NEXT_PUBLIC_*` ke alawa kuch client par nahi. Bot `/status` par kabhi secret nahi.
5. **Input validation:** request id regex, channel `@username|-\d+`, invite URL sirf
   `t.me|telegram.me|telegram.dog`, URLs `https:` only, admin-patch sanitization (numbers clamp).
6. **Ownership:** dusre ka request id padhna → **403**.
7. **No source leak:** caption/file-name/`@username` scrubbing (§8.4).
8. **Data safety:** file-backed courses kabhi physically delete nahi (§9.8).

---

## 11. 🔌 API ENDPOINTS (ek catch-all router `src/app/api/[...path]/route.ts`)

```
POST   /api/auth/login            student login/signup → Set-Cookie
POST   /api/auth/logout           GET /api/auth/session
POST   /api/auth/save-login       login history
GET    /api/config                public site config (appName, logo, telegramJoinUrlConfigured, bot username, limits)
GET    /api/batches               course list (login zaroori)
GET    /api/batches/[batchId]     course detail (folders/videos/pdfs, paginated)
GET    /api/video/[batchId]/[videoId]   ⭐ watch payload: courseName, topic, bot{}, deliveryMode:"telegram-bot",
                                        fileSize, siblings — NO embedUrl/iframe/stream fields
POST   /api/tg/request            ⭐ deep link banao (8 layers)
GET    /api/tg/request?id=        link status (ownership check)
POST   /api/admin/login|logout    GET /api/admin/me
GET|POST /api/admin/settings      site settings + secret health
GET|POST /api/admin/batches       course CRUD (DB-only overrides)
GET|POST /api/admin/tree          node CRUD (rename/move/hide/delete/add)
GET|POST /api/admin/videos        video meta
GET|POST /api/admin/telegram      scan task push + group registry + progress
GET|POST /api/admin/telegram/purge  preview / execute
GET|POST /api/admin/bot           bot config + stats + users + tasks + events + globalQuota
GET|POST /api/admin/accounts      student accounts
GET    /api/admin/logins          login history
GET    /api/admin/db-test         RTDB connectivity check
```
**Hata do:** `/api/tg/stream/[token]`, `/api/tg/thumb/[token]`, `/api/pdf/[batchId]/[pdfId]`
(PDF bhi bot se), `/api/admin/videos` ka stream-related hissa.

---

## 12. 🌍 ENVIRONMENT VARIABLES

### 12.1 Vercel (website) — **kitne kam ho gaye hain, dhyan se dekho**

**Mandatory (5):**
| Var | Note |
|---|---|
| `ADMIN_SESSION_SECRET` | **missing = production me 503.** 32+ random chars. Bot me **exact same** value |
| `ADMIN_EMAIL` | admin login id |
| `ADMIN_PASSWORD` | admin password (special chars hon to `.env` me **quotes** me — `#` truncate ho jata hai) |
| `FIREBASE_PROJECT_ID` | |
| `FIREBASE_CLIENT_EMAIL` | |
| `FIREBASE_DATABASE_URL` | `https://<project>.firebaseio.com` (ya `.firebasedatabase.app`) |
| `FIREBASE_PRIVATE_KEY` | poora PEM, `\n` ke saath ek line me |

**Recommended (4):**
`NEXT_PUBLIC_APP_DOMAIN` (= `https://studyhelperdoc.vercel.app`),
`NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` (bot ka username, `@` ke bina — deep link isi se banta hai),
`NEXT_PUBLIC_TELEGRAM_CHANNEL_URL` (join link; khaali/placeholder ho to UI me CTA hi nahi dikhta),
`CORS_ALLOWED_ORIGINS` (comma separated).

**Optional:** `NEXT_PUBLIC_APP_LOGO_URL`, `NEXT_PUBLIC_DEFAULT_IMAGE_URL`,
`NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_DISABLE_CONTENT_GUARD`,
`STUDENT_SESSION_SECRET`, `TELEGRAM_CREDIT_USERNAME`, `TELEGRAM_CONTACT_USERNAME`,
`ADMIN_EMAIL_HASH`/`ADMIN_PASSWORD_HASH`/`ADMIN_SALT`, `TG_MEDIA_TOKEN_TTL_DAYS`.

**❌ Ab zaroorat NAHI (Vercel se hata do):** `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
`TELEGRAM_SESSION_STRING`, `TELEGRAM_BOT_TOKEN`, `CLOUDFLARE_STREAM_WORKER_URL`,
`DEFAULT_YOUTUBE_URL`. (Telegram ka saara kaam bot karta hai — ye website me daalne se
session conflict ka khatra rehta hai.)

### 12.2 Render (bot) — Web Service

**Mandatory:** `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_BOT_TOKEN`,
`TG_SESSION_STRING` (**alag session**), `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
`FIREBASE_DATABASE_URL`, `FIREBASE_PRIVATE_KEY`, `ADMIN_SESSION_SECRET` (**Vercel jaisa same**),
`OWNER_TG_ID`.

**Recommended:** `BOT_MAX_PARALLEL=1`, `BOT_DOWNLOAD_DIR=/tmp/shd_downloads`,
`BOT_STATE_DB=/tmp/shd_bot_state.db`, `PYTHONUNBUFFERED=1`, `APP_NAME=Study helper Doc`,
`ADMIN_TG_IDS`, `BOT_SEARCH_BUDGET_SEC=120`.

**Optional:** `JOIN_GATE_CHANNEL`, `JOIN_GATE_INVITE_URL`, `BOT_HEALTH_TOKEN`,
`BOT_DISABLE_HEALTH`, `BOT_HEALTH_PORT`, `BOT_NO_RETRY`.

**`PORT` khud Render deta hai — set mat karna.**

---

## 13. 🚀 DEPLOY

### 13.1 Website → Vercel
Repo import → framework **Next.js** (auto) → Build `npm run build` → Output default →
env vars §12.1 → Deploy. Domain: `studyhelperdoc.vercel.app`.

### 13.2 Bot → Render (FREE)
Render → **New → Web Service** → repo → Branch `main` → Root Directory **khaali**:

| Field | Value |
|---|---|
| Build command | `pip install --upgrade pip && pip install -r telegram-bot/requirements.txt` |
| **Start command** | `python telegram-bot/bot.py` |
| Health check path | `/healthz` |
| Plan | **Free** · Region **Singapore** · **Num instances 1** |

Ya root ke `render.yaml` se **New → Blueprint**.

**Free tier ki 3 sachchaiyan:**
1. **15 min bina HTTP traffic → service SO jati hai.** External pinger (UptimeRobot /
   cron-job.org) `/healthz` par **har 5-10 min** hit kare. Self-ping kaam nahi karta.
2. Sote waqt ke Telegram updates **queue** me reh jate hain; cold start ~30-60s.
3. **Disk ephemeral + 512 MB RAM** → `maxUploadMb` **300-700** rakho; `/tmp` restart par
   saaf (asli state RTDB me hai, deletion queue restart-safe).

24×7 bina jhanjhat → VPS (₹300-500/mo) ya Oracle Cloud free tier (systemd unit README me).

### 13.3 Pehli baar chalane ka order
1. Vercel env bharo → deploy → `/admin` login → Settings me app details.
2. `python bot.py --login` → **alag** session string → Render env me daalo.
3. Render deploy → `/healthz` 200 → `/ready` 200.
4. Admin → **Telegram Bot Delivery** → bot username + credit/contact → Save → **ONLINE**.
5. Admin → **Telegram Sync Studio** → group link → **Scan** → JSON bharega.
6. Student login → course → lecture → **▶ Open in Telegram** → video private chat me.
7. (Optional) Join-gate ON → bot ko channel ka **ADMIN** banao → test.

---

## 14. ✅ ACCEPTANCE CHECKLIST (har build ke baad)

```
□ npx tsc --noEmit                      → 0 errors
□ npm run build                         → exit 0 (saare routes)
□ python bot.py --selftest              → PASSED (≥60 checks; health + gates included)
□ GET / , /admin , /batch/58 , /watch/58/<vid>  → 200
□ GET /api/config                       → telegramJoinUrlConfigured sahi
□ GET /api/video/…                      → deliveryMode "telegram-bot", NO embedUrl/iframe/stream fields
□ POST /api/tg/request (source-less)    → 409 NO_SOURCE (English message)
□ POST /api/tg/request (valid)          → deepLink + quota {used,limit,remaining}
□ same video dobara                     → reused:true, quota spend nahi
□ quota khatam                          → 429 DAILY_LIMIT + contact handle + resetInSec
□ 16th link / 10 min                    → 429 RATE_LIMITED
□ dusre user ka request id              → 403
□ admin purge preview                   → file-backed courses protected, data/batches/*.json UNCHANGED (git status clean)
□ PORT=10000 python bot.py              → /healthz 200, /ready 503 (jab tak connected nahi)
□ grep -r "iframe|tg/stream|cloudflare|SmartVideoPlayer|pdfjs" src/ → 0 hits
□ UI me koi Devanagari string nahi      → 0 hits
□ total source files ≤ ~20
```

---

## 15. 🔁 MIGRATION MAP (agar purane repo se convert karna ho)

| Purana (86 files) | Naya |
|---|---|
| `src/lib/{db,batchEngine,tgParser,tgMatch,tgCrypto,tgClient,botDelivery,tgPurge,rtStore,studentAuth,adminAuth,httpGuards,serverSecrets,clientDownloads}.ts` | **`src/lib/site.ts`** (tgClient + clientDownloads + tgCrypto ka streaming hissa **delete**) |
| `src/app/api/**/route.ts` (25 files) | **`src/app/api/[...path]/route.ts`** |
| `src/app/admin/page.tsx` + `src/components/admin/{TelegramBotPanel,TelegramPurgePanel}.tsx` | **`src/app/admin/page.tsx`** (panels inline) |
| `src/components/{TelegramDeliveryCard,LoginGateCard,PleaseWaitScreen,SafeImage,GlowingBackButton,ContentGuard,AmbientBackground,ComingSoonState}.tsx` | pages ke andar inline (jo 2+ pages me use ho wahi `components/` me) |
| `src/components/{SmartVideoPlayer,ProgressivePdfViewer}.tsx`, `src/app/downloads/**`, `cloudflare-worker/**`, `src/app/api/tg/{stream,thumb}/**`, `src/app/pdf/**` | **DELETE** |
| `telegram-bot/{bot,matcher,store,vault,healthz}.py` | **`telegram-bot/bot.py`** |
| deps: `pdfjs-dist`, `telegram` (GramJS) | **DELETE** (sirf `next react react-dom firebase-admin lucide-react tailwind`) |

---

## 16. 📝 OUTPUT EXPECTATIONS

1. Pehle **file tree** dikhao (confirm karo ≤ ~20 files), fir code.
2. Har file ke top par comment banner: kya karta hai, kaunse section ka hai.
3. Code comments **Hinglish** me, UI/bot text **English** me.
4. Har feature ke saath uska **self-test/check** bhi likho.
5. Koi placeholder/TODO mat chhodo — "baad me dekhenge" chalega nahi.
6. End me §14 checklist ka result do (kya pass, kya fail).
7. Koi nayi dependency add karne se pehle batao — default **nahi** leni.

**Yaad rakho:** video website par **kabhi play nahi hoti** — sirf Telegram bot se milti hai.
Bot hi scan karta hai, bot hi deliver karta hai, website sirf dikhata hai + links banata hai.
