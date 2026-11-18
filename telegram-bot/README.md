# 🤖 Telegram Delivery Bot — Study helper Doc

Website par video player ki jagah ab ek button hai: **▶ Open Video in Telegram**.
Wo button ek deep-link kholta hai (`https://t.me/<your_bot>?start=<requestId>`), aur
**ye bot** us lecture ko dhoondh kar user ko privately bhejta hai — bina stutter,
bina 1–2 second jump (jo Cloudflare/Vercel chunked streaming me hota tha).

Bot **aapke khud ke server par chalta hai** (Vercel par nahi — wahan long-lived
process allowed nahi hota). Website sirf Firebase RTDB me request likhti hai;
bot wahi padhta hai.

---

## 1. What this folder contains

| File | Kaam |
|---|---|
| `bot.py` | Main bot: request poll, search, delivery, progress, auto-delete, limits, admin commands, CLI |
| `matcher.py` | Title / topic / course matching engine (Hindi + English fuzzy, dedupe, caption builder) |
| `store.py` | State layer: **Firebase RTDB** (primary) → **SQLite `bot_state.db`** (fallback) |
| `vault.py` | Website ke encrypted vault se `apiId / apiHash / botToken / session` padhna + decrypt |
| `requirements.txt` | Python dependencies (pinned) |
| `.env.example` | Environment template — copy to `.env` |
| `README.md` | Ye file |

Runtime-generated (git-ignored): `bot_state.db`, `downloads/`, `shd_user.session`, `.env`.

---

## 2. Requirements

- **Python 3.9+** (3.11 ya 3.12 recommended)
- Ek **Telegram bot** (@BotFather se bana hua) → `TELEGRAM_BOT_TOKEN`
- Ek **Telegram user account** jo aapke content channels/groups ka member ho
  → uska session (bot isi se search + download karta hai)
- **API credentials** from <https://my.telegram.org> → `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`
- Website ke Firebase RTDB tak access (wahi `ADMIN_SESSION_SECRET`, `FIREBASE_*`
  jo Vercel par already hain — **reuse** kar sakte hain)
- 24×7 chalne wali koi bhi jagah: VPS, Raspberry Pi, Windows PC, Railway,
  Render, Fly.io, ya ghar ka server. Docker image: `python:3.12-slim`.

> 💡 Bot ko source channel me **admin hone ki zaroorat nahi** — sirf member hona
> chahiye. Restricted channels (noforwards) par bot `clean` mode use karta hai.

---

## 3. Setup (10 minutes)

```bash
cd telegram-bot

# 1) virtualenv + dependencies
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 2) environment file
cp .env.example .env
nano .env                          # values bharein (neeche section 4)

# 3) bot ke liye ALAG user session banayein  ⚠️ zaroori
python3 bot.py --login
#    → phone number + OTP (+ 2FA password agar hai)
#    → ek session string print hoga; use .env ke TG_SESSION_STRING me paste karein
#    → saath hi shd_user.session file bhi ban jati hai (backup)

# 4) sab kuch ready hai ya nahi — check
python3 bot.py --info
python3 bot.py --selftest          # offline tests (matcher/vault/store/quota)

# 5) bot chalayein
python3 bot.py
```

### ⚠️ Session ke baare me sabse important baat

Website (Vercel) **GramJS** session use karti hai, ye bot **Telethon**. Dono format
alag hain, aur **ek hi session do alag IP par ek saath kholne se Telegram use
terminate kar deta hai** (`406 AUTH_KEY_DUPLICATED`).

Isliye:

- ✅ **Recommended:** `python3 bot.py --login` se bot ke liye **alag** session banayein
  (ek hi Telegram account dobara login kar sakte hain — 2 sessions allowed hain).
- ❌ Website ka session string directly `TG_SESSION_STRING` me mat daaliye.
- Bot phir bhi vault se GramJS session padh lega (auto-convert karta hai), par
  wo sirf **testing** ke liye theek hai — production me terminate ho sakta hai.
- Purani `session.py` (repo root) website ke liye GramJS session banati hai — usse
  chhedein nahi. Bot ke liye `bot.py --login` hi use karein.

---

## 4. `.env` values

| Variable | Kahan se | Zaroori? |
|---|---|---|
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | my.telegram.org | ✅ (vault me ho to optional) |
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/newbot` | ✅ |
| `TG_SESSION_STRING` | `python3 bot.py --login` | ✅ |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_DATABASE_URL` / `FIREBASE_PRIVATE_KEY` | Vercel env (same values) | ✅ website se sync ke liye |
| `ADMIN_SESSION_SECRET` | Vercel env (same value) | ✅ vault decrypt + quota |
| `OWNER_TG_ID` | apna Telegram numeric ID (`@userinfobot` se pata karein) | ✅ admin commands |
| `ADMIN_TG_IDS` | comma-separated extra admin IDs | optional |
| `BOT_MAX_PARALLEL` | ek saath kitne downloads (default `2`) | optional |
| `BOT_DOWNLOAD_DIR` | temp download folder (default `./downloads`) | optional |
| `BOT_SEARCH_BUDGET_SEC` | deep search ka time budget (default `120`) | optional |

> `ADMIN_SESSION_SECRET` website ke Vercel env se **exactly same** hona chahiye —
> warna vault decrypt nahi hoga aur request records bhi sign/verify nahi honge.

---

## 5. Kya-kya user ko dikhta hai (sab English)

Deep link kholne par bot:

```
🔎 Finding your lecture…
⬇️ Downloading… ██████░░░░ 42% • 3.4 MB/s • 12.8/30.4 MB • ETA 5s
⬆️ Uploading… ████░░░░░░ 31% • 2.1 MB/s
✅ Done! Your lecture is above.
⏳ This video will be deleted automatically after 2 hours.
```

Caption (fixed order — aap admin panel se credit handle badal sakte hain):

```
📺 <Title>
📚 <Topic / folder path>
🎓 <Course name>

Extracted By @krishna84
```

Rules jo bot **kabhi break nahi karta**:

- Koi bhi `@username` ya `t.me` link caption me nahi jata (sirf credit handle rehta hai).
- `clean` mode me "Forwarded from …" source name kabhi visible nahi hota.
- `forward` mode on ho, par source caption me `@` ho ya channel `noforwards` ho →
  bot khud `clean` (download + re-upload) par aa jata hai.
- Ek hi lecture 2 channels me mile → **sirf best match** (course match mandatory).
- Har failure ka English message jata hai; kuch bhi "stuck" nahi dikhta.

### 🛡️ Anti-theft (koi poora course utha na le)

| Layer | Kahan | Default |
|---|---|---|
| Daily limit per user (rolling 24h) | **website + bot dono** | 12 videos |
| Deep-link throttle per login | website | 15 links / 10 min |
| Deep-link throttle per IP | website | 30 links / 10 min |
| Pending (undelivered) links per user | website | 3 |
| Same-video cooldown → **link reuse** (naya quota spend nahi) | website | 5 min |
| **Single-use link** (`usedCount >= requestReuseLimit` → link mar jata hai) | bot | 1 use |
| **Account binding** — jo pehla Telegram user link kholta hai, link usi ka | bot | on |
| **Global circuit breaker** — poori site par 24h me max deliveries | bot + website | 500 |
| Request TTL (deep-link expiry) | website + bot | 168 h |
| Auto-delete delivered file | bot | 2 h |

Sab knobs Admin Panel → **Telegram Bot Delivery → Anti-theft & fair use** se badalte
hain (`globalDailyLimit`, `requestReuseLimit`, `requestCooldownMin`,
`maxPendingPerUser`). Rate limits **database-backed** hain, isliye Vercel ke har
container par same ginti chalti hai (in-memory Map wala purana bug nahi).

Naye English messages jo is wajah se user ko dikh sakte hain:

```
🔐 This link belongs to another account.
🔁 This link has already been used. Each link works only once…
🚦 Delivery is temporarily full for today because of heavy traffic.
```

Error / limit messages:

```
❌ Sorry, this video is not available.
⛔ Your daily limit is finished. You can request 12 videos every 24 hours.
   To increase your limit, contact @krishna84
🔒 The source channel restricts saving content…
📦 This file is larger than {limit} MB…
⏰ This link has expired.
⚠️ Something went wrong while preparing your video. Error: {error}
```

---

### 🔒 Channel join-gate (delivery se pehle channel join zaroori)

Admin Panel → **Telegram Bot Delivery → Channel join gate** se ON hota hai
(koi `.env` change nahi chahiye — setting Firebase RTDB `bot_state/config` me
jaati hai aur bot use ~30 second me pick kar leta hai).

| Setting | Matlab |
|---|---|
| `joinGateEnabled` | ON = membership check chalega |
| `joinGateChannel` | `@username` ya `-100xxxxxxxxxx` — kaunsa channel |
| `joinGateInviteUrl` | Button ka link (khaali = `https://t.me/<username>`; private channel ke liye `https://t.me/+…` yahan daalein) |

Flow:

```
Student deep-link kholta hai
   ↓
bot membership check karta hai  (pehle BOT session, fail hone par USER session)
   ↓ member NAHI  → "📢 Join our channel" + "✅ I have joined" buttons
   ↓                 link consume NAHI hota, quota NAHI katti
   ↓ "I have joined" → live re-check → member mila to wahi request turant deliver
   ↓ member HAI   → normal delivery (anti-theft gate → quota → search → upload)
```

Zaroori baatein:

- **Bot ko us channel me ADMIN banayein** — warna Telegram member lookup refuse
  karta hai. Aisi situation me gate **fail-open** rehta hai (video chali jaati
  hai) taaki galat config ki saza student ko na mile; bot log me
  `join-gate: membership check failed (…)` warning aur RTDB event
  `join_gate_check_failed` dikhta hai.
- Confirmed members **10 minute cache** rehte hain → repeat requests instant.
- Events: `join_gate_block` (roka), `join_gate_pass` (verify hoke delivery).

## 6. Commands

**User:** `/start <requestId>` • `/help` • `/status` • `/find <course> | <title>`

**Admin (sirf `OWNER_TG_ID` / `ADMIN_TG_IDS`):**

| Command | Kaam |
|---|---|
| `/stats` | total users, all-time videos sent, last-24h, pending deletions |
| `/users [n]` | sabhi users + unka usage (default 20) |
| `/limit_set <uid> <n>` | kisi user ka limit seedha `n` kar dein (e.g. `/limit_set 12345 15` → 15) |
| `/limit_up <uid> <n>` / `/limit_add <uid> <n>` | limit badhayein |
| `/limit_down <uid> <n>` | limit ghatayein |
| `/limit_all <n>` | **sabka** limit `n` kar dein (level up everyone) |
| `/limit_default <n>` | naye users ka default limit |
| `/broadcast <message>` | sab users ko message |
| `/ban <uid>` / `/unban <uid>` | user block / unblock |
| `/pending` | pending requests + deletion queue |
| `/config` | current config dikhayein |
| `/pause [msg]` / `/resume` | delivery rok dein / chalu karein |
| `/ping` | alive check |

Website ke **Admin Panel → Telegram Bot Delivery** tab se bhi wahi sab ho jata hai
(limit adjust, level-up-all, broadcast, pause, config) — dono side same Firebase
state padhti/hai likhti hai.

---

## 7. 24×7 chalane ke tareeke

### A) Linux VPS — systemd (recommended)

`/etc/systemd/system/shd-telegram-bot.service`:

```ini
[Unit]
Description=Study helper Doc Telegram Delivery Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/telegram-bot
ExecStart=/home/ubuntu/telegram-bot/.venv/bin/python bot.py
Restart=always
RestartSec=8
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now shd-telegram-bot
sudo journalctl -u shd-telegram-bot -f     # live logs
```

### B) Screen / tmux (quick test)

```bash
screen -S shdbot
cd telegram-bot && source .venv/bin/activate && python bot.py
# detach: Ctrl+A then D   |   reattach: screen -r shdbot
```

### C) Docker

```dockerfile
FROM python:3.12-slim
WORKDIR /bot
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "bot.py"]
```

```bash
docker build -t shd-telegram-bot .
docker run -d --name shdbot --restart unless-stopped \
  --env-file .env \
  -v $(pwd)/downloads:/bot/downloads \
  shd-telegram-bot
```

> Downloads folder ko volume/SSD par rakhein — video temporarily wahan aati hai
> (upload ke baad turant delete). Free space = biggest video × `BOT_MAX_PARALLEL`.

---

## 8. Website side wiring (ek baar)

1. **Admin Panel → Telegram Bot Delivery** tab kholein.
2. `Bot username` me apne bot ka username daalein (bina `@`).
3. `Delivery mode on the watch page` = **Telegram bot (recommended)**.
4. `Daily video limit` = 12, `Auto-delete after` = 2 hours (defaults already set).
5. `Delivery method` = **Clean re-upload** (source name kabhi na dikhe).
6. **Save bot configuration** dabayein.
7. Panel me bot **ONLINE** dikhna chahiye (heartbeat ~30s me aata hai).
8. In-app streaming bhi chahiye ho to **Cloudflare Worker secret** copy karke
   `cloudflare-worker/worker.js` ke top par `WORKER_SHARED_SECRET` me paste karein,
   worker redeploy karein, tab hi **Require worker secret** ON karein.

Test: website par koi lecture kholein → **Open Video in Telegram** → bot me
`/start` → progress → video → 2 ghante baad auto-delete.

### 🧹 Sab kuch ek button me delete karna ho

Admin Panel → **Telegram Sync Studio** ke sabse neeche **Danger Zone — Remove
everything that came from Telegram** card hai:

1. **Scan now** dabayein (read-only) → dikhta hai kitne Telegram video/PDF links,
   sync-created lectures, synced courses, group records aur pending requests hain,
   aur kya-kya **protected** hai.
2. Scope chunein (links strip / sync-created lectures / poore synced courses /
   group registry / pending requests / Telegram embeds / bot user-quota reset).
3. `DELETE` type karke confirm karein.

**Kabhi delete nahi hota:** `data/batches/*.json` (original/real courses — file-backed
course poora delete hi nahi ho sakta, sirf uske Telegram links strip hote hain),
manually uploaded courses, YouTube links, student accounts, site settings aur bot
configuration. Purge ke baad bina Telegram file wale lectures English
"content unavailable — it will be uploaded soon" card dikhate hain.

---

## 9. Troubleshooting

| Symptom | Wajah / fix |
|---|---|
| `Missing: TELEGRAM_BOT_TOKEN` | `.env` me token daalein, ya Admin Panel → Telegram Sync Studio me bot token save karein (vault) |
| `406 AUTH_KEY_DUPLICATED` | Ek hi session 2 jagah chal raha hai → `python3 bot.py --login` se alag session banayein |
| `Session string invalid / expired` | Session logout ho gaya → dobara `--login` |
| Bot chal raha hai par request nahi aati | `FIREBASE_*` / `ADMIN_SESSION_SECRET` website se mismatch, ya delivery mode abhi `in-app-player` hai. `python3 bot.py --info` se backend check karein (`rtdb` hona chahiye, `sqlite` nahi) |
| `No matching lecture found` | User account us channel ka member nahi, ya `Max dialogs / messages per chat` kam hai → admin panel me badhayein |
| Slow download | `pip install cryptg`, `BOT_MAX_PARALLEL=1`, aur host ki bandwidth check karein |
| Video delete nahi hui | `autoDeleteHours` 0 set hai, ya bot restart ke waqt queue purge hui — queue restart-safe hai, `/pending` se check karein |
| `sqlite` backend dikh raha hai | Firebase creds missing/wrong → RTDB mode me hi website ke saath sync hota hai |

Logs me har step `[bot]`, `[search]`, `[delivery]`, `[quota]` prefix ke saath aata hai.
`python3 bot.py --selftest` green hona chahiye (matcher, vault interop, quota,
deletion queue sab offline test hota hai).

---

## 10. Security notes

- `.env`, `*.session`, `bot_state.db`, `downloads/` — **kabhi git me commit na karein**
  (repo `.gitignore` me already hain).
- Bot sirf **private** delivery karta hai; koi bhi file public channel me nahi jati.
- Delivered file `autoDeleteHours` (default 2h) baad delete ho jati hai —
  deletion queue restart-safe hai (RTDB/SQLite me stored).
- Admin commands sirf whitelisted Telegram IDs ke liye khulte hain.
- Website ke `X-Worker-Secret` enforcement aur stream guards ke baare me
  Admin Panel → Telegram Bot Delivery me detail hai.
