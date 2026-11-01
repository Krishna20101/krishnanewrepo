# 📘 Study helper Doc — Complete A-to-Z Portal (v3 "Smooth Edition")

**Live domain:** `https://studyhelperdoc.vercel.app`
**Stack:** Next.js 14 (App Router) + Firebase RTDB + GramJS (Telegram MTProto) + Cloudflare Worker (free edge cache)
**Cost:** ₹0 (Vercel Hobby + Cloudflare Free + Firebase Free + Telegram Free)

---

## ✨ Is Version (v3) Me Kya-Kya Naya / Fix Hua

| # | Problem (aapne batayi) | Fix |
| --- | --- | --- |
| 1 | `406: AUTH_KEY_DUPLICATED` par sync fail | Admin scan **ephemeral** (kaam khatam = 0.1s me disconnect), thumbnails user-session se **hata diye**, aur **@BotFather Bot Token** streaming add ki (har container ki apni temporary `auth_key` = 0% collision). Channel ab **PRIVATE** rakh sakte hain (bot ko ADMIN bana dein). |
| 2 | Video "jhal-jhal / andar ka character hilta" | **Byte-exact streaming engine**: Telegram se short/adhura block aane par ab wo silently aage nahi badhta — fill-loop + retry hota hai, warna browser us range ko dubara maangta hai. Purane code me beech ke bytes miss ho jate the (Chrome frames aage-piche phenkta tha). |
| 3 | Cloudflare par zyada jhal-jhal | **Worker v3**: har 2MB block ki length + `Content-Range` verify hoti hai, **adhura block kabhi cache nahi hota** (pehle 7 din tak corrupt block serve hota rehta tha!). Sath hi **16MB range-cap** — Free plan ke 50-subrequest limit me ab kabhi fail nahi hota. |
| 4 | Vercel par 400MB video stream toot jata | Har 206 response max **32MB** (Vercel Hobby ~60s limit safe). Chrome agla slice khud maang leta hai = playback continuous. |
| 5 | Player atakta / black screen | Naya **SmartVideoPlayer**: Gap-Jump controller (buffer hole ke paar jump), Stall watchdog (3s nudge, 6.5s reload), Edge→Direct auto-failover, resume-from-last-position, engine badge (`BOT STREAM • EDGE HIT • Buffer 42s`). |
| 6 | Caption-only YouTube lectures (`Index/Title/Batch/Link: https://youtu.be/...`) sync nahi hote the | Scanner ab **bina file wale messages** bhi padhta hai. Agar caption me `Title:` + (`Batch:`/`Topic:`/`Course:`) + YouTube link hai to wo lecture **automatic YouTube Embed** ban jata hai (Add New + JSON Merge dono me). `Error: 'utf-8' codec...` jaise extractor crash-logs caption se **saaf** ho jate hain. |
| 7 | Sirf `JSON Merge` chunne par neeche list nahi aati thi | Ab **har sync ka record hamesha save hota hai** — success, partial ya error. Neeche `Synced Telegram Groups` list hamesha dikhti hai (status badge + reason + `Re-Sync` + `Open Course` + `Delete Course` + `Remove Record`). |
| 8 | PDF "kahi kahi khulta nahi", ek saath pura load hota tha | Naya **ProgressivePdfViewer** (pdf.js range requests): pehla page ~300-500KB me khulta hai, baaki pages **scroll par** aate hain. Door ke pages ka canvas RAM se free (max 8 live canvas) → low-RAM phone par bhi smooth. Zoom, page-jump, fullscreen, `Please wait, page N load ho raha hai...` |
| 9 | Download browser me chala jata tha (koi bhi copy kar sakta tha) | Ab **In-App Offline Vault** (IndexedDB): file phone ke Downloads folder me **nahi** jati. Lecture website ke andar hi save hota hai aur **internet band hone par bhi** wahi se chalta hai. Download **resumable** (Pause/Resume), chunk-wise disk write (RAM flat), storage meter `/downloads` par. |
| 10 | Login system alag rakhna tha | Poora student login ek file me: **`src/lib/login/studentLogin.ts`** (+ admin: `src/lib/login/adminLogin.ts`). Baad me OTP/Firebase/paid-check lagana ho to sirf wahi file badlein. |

---

## 🚀 Deploy — Sirf 3 Step

### Step 1 — GitHub + Vercel
1. Ye poora ZIP GitHub repo me upload karein (`.env`, `node_modules`, `.next` **upload na karein** — `.gitignore` me already hain).
2. Vercel → *Add New Project* → repo select → Framework **Next.js** → **Deploy**.
3. Vercel → *Settings → Environment Variables* me apne existing variables rakhein (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `FIREBASE_*` etc.). **Naya variable sirf 1 hai (optional):** `TELEGRAM_BOT_TOKEN` — aur wo `/admin` panel se bhi daala ja sakta hai, `.env` me zaroori nahi.

### Step 2 — Telegram Bot (2 minute, 100% free, sabse zaroori)
1. Telegram par **`@BotFather`** → `/newbot` → naam dein → **Bot Token** copy karein.
2. Apne course channel/group me us bot ko **ADMIN** bana dein (private channel ke liye zaroori).
3. `/admin` → **Telegram Sync Studio** → **Box 1** me:
   - `API ID`, `API Hash` (my.telegram.org se)
   - **Session String** (`python session.py` se banaya hua — sirf *sync/scan* ke liye)
   - **Optional @BotFather Bot Token** ← isse streaming bot se hoti hai (`406 AUTH_KEY_DUPLICATED` kabhi nahi)
   → **Verify & Save** dabayein (badge `BOT ACTIVE` dikh jayega).

> **Kyun zaroori hai?** User `Session String` par Telegram ka rule hai: *ek session = ek IP*. Vercel par 10-20 containers alag-alag IP se chalte hain → purani string expire (`406`). Bot Token par ye rule **nahi** lagta — har container apni alag temporary key banata hai, isliye 300 users ek saath video dekh sakte hain.

### Step 3 — Cloudflare Worker (free edge cache, smooth 4K-level delivery)
1. `https://dash.cloudflare.com` → **Workers & Pages** → **Create** → **"Start with Hello World!"** (⚠️ *Upload files* button use **mat** karein — wo `.js` reject karta hai).
2. Naam: `shd-stream` → **Deploy** → **Edit code** (`</>`) → sample code delete → **`cloudflare-worker/worker.js`** ka poora code paste → **Deploy**.
3. Worker ke top par 2 lines apne hisab se:
   ```js
   const ORIGIN_SITE_URL = "https://studyhelperdoc.vercel.app";
   const ALLOWED_ORIGIN_KEYWORD = "studyhelperdoc";
   ```
4. Jo URL mile (`https://shd-stream.<subdomain>.workers.dev`) use `/admin → Website Settings → Cloudflare Stream Worker URL` me paste karke **Save** karein.

**Worker kaise kaam karta hai (v3):** 2MB aligned blocks → nearest Indian edge (Mumbai/Delhi/Chennai) par 7 din cache → har response max 16MB (Free plan safe) → **har block ki length + offset verify** (corrupt cache = 0%).

---

## 🔐 Security (aapke rules 100% follow)

- **Zero default/fallback admin credentials** — `ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` sirf `.env`/Firebase vault se.
- Admin credentials, Telegram `Session String`, `API Hash`, `Bot Token` → **AES-256-GCM encrypted** Firebase me; client JS me kabhi nahi jate.
- Students ko **source Telegram group/channel kabhi dikhta nahi**: saare links encrypted `token` (`/api/tg/stream/<token>`) me hote hain, captions se `Extracted By:` / `@username` / extractor tags **strip** ho jate hain.
- Direct URL-bar hotlinking blocked (`Sec-Fetch-Dest` + Referer check, Worker par bhi).
- Thumbnails na milne par clean **default placeholder image**.

---

## 🧰 Admin Panel Quick Guide (`/admin`)

| Tab | Kaam |
| --- | --- |
| **Telegram Sync Studio** | Box 1 = credentials vault (Session + Bot). Box 2 = group username/ID + **3 modes**: `➕ Add New Course`, `🔗 JSON Merge Only`, `⚡ Add + JSON Merge`. Neeche **Synced Groups list** (har sync save hoti hai) → `Re-Sync` / `Open Course` / `Delete Course` / `Remove Record`. |
| **Courses Studio** | Course reorder `#1,#2,#3`, `⇈ Top ↑ Up ↓ Down ⇊ Bottom`, `⭐ Important` (top pin + website par star), JSON import, blank course create. |
| **Explorer** | Folder/Video reorder + `⭐` star, YouTube embed add, PDF link add. |
| **Website Settings** | App name/domain, default image, Cloudflare Worker URL, announcement, video-download allow/block. |
| **Saved Logins** | Jo students login karte hain (server-only capture). |

**Max Messages** = 1500 default. Bade group (5000+ items) ke liye 3000-5000 karein.

---

## 📱 Student Side Features

- **Watch page:** SmartVideoPlayer (Edge/Direct/Offline badge), `-10s/+10s`, speed `0.75x–2x`, `Turn Screen` (landscape rotate), `Save Offline`, resume-from-last, PDF notes button.
- **PDF page:** progressive page-by-page viewer (top-first, scroll par neeche), zoom, page jump, fullscreen, `Save Offline`, `Browser View` fallback.
- **`/downloads` dock:** VIDEO / PDF tabs, live progress, **Pause/Resume**, storage meter, `Play Offline` / `Read Offline`, optional `Export File`, delete.
- Sab jagah **"Please wait, loading…"** indicators; folder/course data **on-demand page-wise** (low-RAM phone safe).
- `TEST` / `LIVE` = Coming Soon (jaisa aapne kaha).

---

## 🧪 Local Testing

```bash
npm install          # postinstall pdf.worker.min.js ko public/ me copy karta hai
npm run dev          # http://localhost:3000  (preview port 3000)
npm run build        # production build check
npm run hash-admin   # ADMIN_PASSWORD ka bcrypt hash banane ke liye
```

`session.py` (project root ke bahar `/home/user/session.py` ya repo me) se **naya Session String** banayein:
```bash
python session.py     # IPv4 GramJS StringSession + Group IDs list karta hai
```

---

## 🩺 Troubleshooting

| Symptom | Reason | Fix |
| --- | --- | --- |
| `406 AUTH_KEY_DUPLICATED` | Purani session string 2 IP par ek saath khul gayi thi → Telegram ne **us string ko** expire kiya (aapka account 100% safe) | `python session.py` se **nayi string** + **Bot Token** Box 1 me save karein |
| Video atakta/black | Cloudflare Worker URL set nahi ya worker purana (v2) hai | **v3 `worker.js`** dubara paste karein; ya `/admin → Website Settings` me Worker URL **khali** kar dein (direct Vercel chalega) |
| Video "jhal-jhal" sirf ek hi lecture me, Telegram app me sahi | Wo `.mp4` extractor se **broken frame-order (B-frame/CTTS)** ke saath bani hai | Us file ko re-mux/re-encode karke Telegram par dubara upload karein: `ffmpeg -i in.mp4 -c:v libx264 -preset veryfast -crf 23 -c:a aac -movflags +faststart out.mp4` (website side har possible fix already laga hai) |
| PDF khulta nahi | External PDF par CORS block | PDF page par **Browser View** toggle karein, ya PDF ko Telegram par upload karke sync karein |
| Sync ke baad list nahi dikhti | Purana build | Naya code deploy karein — ab record **har haal me** save hota hai (status `SAVED` / `PARTIAL` / `ERROR` + reason) |
| Download paused | Browser band ho gaya tha | `/downloads` → **Resume** (wahin se continue hota hai) |

---

## 📂 Important Files

```
src/lib/tgClient.ts                 Telegram MTProto: bot-first streaming, byte-exact blocks, ephemeral admin scan
src/lib/tgParser.ts                 Caption parsing (Index/Title/Topic/Batch/Link), YouTube auto-detect, course tree builder, JSON deep-merge
src/lib/clientDownloads.ts          In-App Offline Vault (IndexedDB chunks, resumable, low-RAM)
src/lib/login/studentLogin.ts       👈 STUDENT LOGIN — future changes sirf yahan
src/lib/login/adminLogin.ts         👈 ADMIN LOGIN client helpers
src/lib/adminAuth.ts                Admin hash verify + cookie guard (server)
src/components/SmartVideoPlayer.tsx Gap-jump + stall-recovery + offline-first player
src/components/ProgressivePdfViewer.tsx  pdf.js progressive page-by-page viewer
src/app/api/tg/stream/[token]/route.ts   Continuous HTTP 206 stream (32MB cap)
cloudflare-worker/worker.js         Edge Streamer v3 (byte-exact, 16MB cap)
session.py                          Naya GramJS StringSession generator
```

## 🔥 Firebase RTDB Rules (`database.rules.json`)
```json
{ "rules": { ".read": false, ".write": false } }
```
(Sirf server-side Service Account access — public read/write band.)
