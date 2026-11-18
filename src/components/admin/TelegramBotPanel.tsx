"use client";

/**
 * 🤖 Telegram Bot Delivery — Admin Control Panel
 * ---------------------------------------------------------------------------
 * Website ab video Telegram bot se deliver karwa sakti hai (in-app chunked
 * streaming me stutter/jump aata tha). Is panel se:
 *   • Delivery mode ON/OFF (bot vs in-app player)
 *   • Bot username / daily limit / auto-delete hours / credit & contact handle
 *   • Cloudflare Worker shared secret (worker.js me paste karna hota hai)
 *   • Live stats, users, per-user limit adjust, "Level up everyone"
 *   • Broadcast message + pause/resume
 *   • Recent bot events / task queue (debugging)
 *
 * Data source: GET /api/admin/bot   •  writes: POST /api/admin/bot
 *              POST /api/admin/settings (worker-secret enforcement toggle)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Save,
  Send,
  Shield,
  ShieldCheck,
  TrendingUp,
  TriangleAlert,
  Users,
} from "lucide-react";

// ───────────────────────────────────────────────────────────────── types
interface BotConfigView {
  botUsername?: string;
  dailyLimit?: number;
  quotaWindowHours?: number;
  autoDeleteHours?: number;
  creditUsername?: string;
  contactUsername?: string;
  deliveryMode?: "clean" | "forward";
  paused?: boolean;
  pauseMessage?: string;
  requestTtlHours?: number;
  maxDialogs?: number;
  maxMessagesPerChat?: number;
  heartbeatAt?: number;
  /** 🛡️ anti-theft (v6) */
  globalDailyLimit?: number;
  requestReuseLimit?: number;
  requestCooldownMin?: number;
  maxPendingPerUser?: number;
  joinGateEnabled?: boolean;
  joinGateChannel?: string;
  joinGateInviteUrl?: string;
}

interface BotStatsView {
  backend?: string;
  totalUsers?: number;
  totalVideosSent?: number;
  videosLast24h?: number;
  pendingDeletions?: number;
  botUsername?: string;
  botAlive?: boolean;
  lastHeartbeatAt?: number;
  heartbeatAgoSec?: number;
  deliveryMode?: string;
  dailyLimit?: number;
  autoDeleteHours?: number;
  paused?: boolean;
}

interface BotUserView {
  id?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  limit?: number;
  banned?: boolean;
  totalVideos?: number;
  firstSeen?: number;
  lastSeen?: number;
  recent?: number[];
}

interface BotPanelResponse {
  ok?: boolean;
  stats?: BotStatsView;
  config?: BotConfigView;
  settings?: {
    videoDeliveryMode?: "telegram-bot" | "in-app-player";
    telegramBotUsername?: string;
    dailyVideoLimit?: number;
    autoDeleteHours?: number;
    creditUsername?: string;
    contactUsername?: string;
    allowVideoDownload?: boolean;
    requireWorkerSecret?: boolean;
  };
  workerSecret?: string;
  users?: BotUserView[];
  tasks?: Array<{ id?: string; type?: string; createdAt?: number; status?: string }>;
  events?: Array<Record<string, unknown>>;
  error?: string;
}

// ───────────────────────────────────────────────────────────────── helpers
function apiUrl(path: string) {
  if (typeof window === "undefined") return path;
  const base = String(process.env.NEXT_PUBLIC_SITE_URL || window.location.origin);
  return `${base.replace(/\/$/, "")}${path}`;
}

function fmtTime(ms?: number) {
  if (!ms || ms <= 0) return "—";
  try {
    return new Date(ms).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function fmtAgo(ms?: number) {
  if (!ms || ms <= 0) return "never";
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

function userLabel(u: BotUserView) {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  if (u.username) return name ? `${name} (@${u.username})` : `@${u.username}`;
  return name || String(u.id || "unknown");
}

// ───────────────────────────────────────────────────────────────── UI bits
function StatTile({
  label,
  value,
  icon: Icon,
  tone = "cyan",
}: {
  label: string;
  value: string | number;
  icon: typeof Users;
  tone?: "cyan" | "purple" | "emerald" | "rose" | "amber";
}) {
  const toneMap: Record<string, string> = {
    cyan: "border-cyan-400/25 bg-cyan-500/10 text-cyan-300",
    purple: "border-purple-400/25 bg-purple-500/10 text-purple-300",
    emerald: "border-emerald-400/25 bg-emerald-500/10 text-emerald-300",
    rose: "border-rose-400/25 bg-rose-500/10 text-rose-300",
    amber: "border-amber-400/25 bg-amber-500/10 text-amber-300",
  };
  return (
    <div className="glass-card rounded-3xl border border-white/10 p-4">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex h-8 w-8 items-center justify-center rounded-xl border ${toneMap[tone]}`}
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
          {label}
        </span>
      </div>
      <div className="mt-2.5 text-2xl font-black text-white">{value}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-black uppercase tracking-widest text-cyan-300">
        {label}
      </label>
      {children}
      {hint ? (
        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

const inputCls =
  "w-full rounded-2xl border border-white/15 bg-[#060919] px-4 py-2.5 text-sm font-semibold text-white outline-none focus:border-cyan-400";

// ───────────────────────────────────────────────────────────────── panel
export default function TelegramBotPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [data, setData] = useState<BotPanelResponse | null>(null);
  const [copied, setCopied] = useState("");

  // delivery mode
  const [mode, setMode] = useState<"telegram-bot" | "in-app-player">("telegram-bot");

  // config form
  const [botUsername, setBotUsername] = useState("");
  const [dailyLimit, setDailyLimit] = useState(12);
  const [autoDeleteHours, setAutoDeleteHours] = useState(2);
  const [creditUsername, setCreditUsername] = useState("krishna84");
  const [contactUsername, setContactUsername] = useState("krishna84");
  const [deliveryMode, setDeliveryMode] = useState<"clean" | "forward">("clean");
  const [paused, setPaused] = useState(false);
  const [maxDialogs, setMaxDialogs] = useState(60);
  const [maxMessagesPerChat, setMaxMessagesPerChat] = useState(40);
  const [requestTtlHours, setRequestTtlHours] = useState(168);

  // 🛡️ anti-theft (v6)
  const [globalDailyLimit, setGlobalDailyLimit] = useState(500);
  const [requestReuseLimit, setRequestReuseLimit] = useState(1);
  const [requestCooldownMin, setRequestCooldownMin] = useState(5);
  const [maxPendingPerUser, setMaxPendingPerUser] = useState(3);
  // 🔒 channel join-gate (delivery se pehle channel membership zaroori)
  const [joinGateEnabled, setJoinGateEnabled] = useState(false);
  const [joinGateChannel, setJoinGateChannel] = useState("");
  const [joinGateInviteUrl, setJoinGateInviteUrl] = useState("");
  const [globalQuota, setGlobalQuota] = useState<{
    limit: number;
    used: number;
    remaining: number;
    tripped: boolean;
  } | null>(null);

  // worker secret enforcement
  const [requireWorkerSecret, setRequireWorkerSecret] = useState(false);

  // broadcast / per-user
  const [broadcast, setBroadcast] = useState("");
  const [busyAction, setBusyAction] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl("/api/admin/bot?users=120"), {
        cache: "no-store",
        credentials: "include",
      });
      const json = (await res.json()) as BotPanelResponse;
      if (!res.ok || !json.ok) {
        setError(json.error || `Failed to load bot panel (${res.status}).`);
        setData(null);
        return;
      }
      setData(json);

      const cfg = json.config || {};
      const st = json.settings || {};
      setMode(st.videoDeliveryMode === "in-app-player" ? "in-app-player" : "telegram-bot");
      setBotUsername(String(cfg.botUsername || st.telegramBotUsername || ""));
      setDailyLimit(Number(cfg.dailyLimit ?? st.dailyVideoLimit ?? 12) || 0);
      setAutoDeleteHours(Number(cfg.autoDeleteHours ?? st.autoDeleteHours ?? 2) || 0);
      setCreditUsername(String(cfg.creditUsername || st.creditUsername || "krishna84"));
      setContactUsername(String(cfg.contactUsername || st.contactUsername || "krishna84"));
      setDeliveryMode(cfg.deliveryMode === "forward" ? "forward" : "clean");
      setPaused(Boolean(cfg.paused));
      setMaxDialogs(Number(cfg.maxDialogs || 60) || 60);
      setMaxMessagesPerChat(Number(cfg.maxMessagesPerChat || 40) || 40);
      setRequestTtlHours(Number(cfg.requestTtlHours || 168) || 168);
      setGlobalDailyLimit(Number(cfg.globalDailyLimit ?? 500) || 0);
      setRequestReuseLimit(Math.max(1, Number(cfg.requestReuseLimit ?? 1) || 1));
      setRequestCooldownMin(Number(cfg.requestCooldownMin ?? 5) || 0);
      setMaxPendingPerUser(Math.max(1, Number(cfg.maxPendingPerUser ?? 3) || 3));
      setJoinGateEnabled(Boolean(cfg.joinGateEnabled));
      setJoinGateChannel(String(cfg.joinGateChannel || ""));
      setJoinGateInviteUrl(String(cfg.joinGateInviteUrl || ""));
      setGlobalQuota(
        (json as { globalQuota?: typeof globalQuota }).globalQuota || null
      );
      setRequireWorkerSecret(Boolean(st.requireWorkerSecret));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error while loading bot panel.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (body: Record<string, unknown>, actionLabel: string) => {
      setBusyAction(actionLabel);
      setError("");
      setNotice("");
      try {
        const res = await fetch(apiUrl("/api/admin/bot"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as BotPanelResponse;
        if (!res.ok || !json.ok) {
          throw new Error(json.error || `Request failed (${res.status}).`);
        }
        return json;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Request failed.");
        return null;
      } finally {
        setBusyAction("");
      }
    },
    []
  );

  const saveConfig = useCallback(async () => {
    setSaving(true);
    const res = await post(
      {
        action: "save_config",
        videoDeliveryMode: mode,
        config: {
          botUsername: botUsername.replace(/^@+/, "").trim(),
          dailyLimit: Math.max(0, Math.round(dailyLimit) || 0),
          autoDeleteHours: Math.max(0, Math.round(autoDeleteHours) || 0),
          creditUsername: creditUsername.replace(/^@+/, "").trim() || "krishna84",
          contactUsername: contactUsername.replace(/^@+/, "").trim() || "krishna84",
          deliveryMode,
          paused,
          maxDialogs: Math.max(5, Math.round(maxDialogs) || 60),
          maxMessagesPerChat: Math.max(5, Math.round(maxMessagesPerChat) || 40),
          requestTtlHours: Math.max(1, Math.round(requestTtlHours) || 168),
          globalDailyLimit: Math.max(0, Math.round(globalDailyLimit) || 0),
          requestReuseLimit: Math.max(1, Math.round(requestReuseLimit) || 1),
          requestCooldownMin: Math.max(0, Math.round(requestCooldownMin) || 0),
          maxPendingPerUser: Math.max(1, Math.round(maxPendingPerUser) || 3),
          joinGateEnabled,
          joinGateChannel: joinGateChannel.trim(),
          joinGateInviteUrl: joinGateInviteUrl.trim(),
        },
      },
      "save-config"
    );
    setSaving(false);
    if (res) {
      setNotice("Bot configuration saved. The bot picks this up within ~30 seconds.");
      await load();
    }
  }, [post, load, mode, botUsername, dailyLimit, autoDeleteHours, creditUsername, contactUsername, deliveryMode, paused, maxDialogs, maxMessagesPerChat, requestTtlHours, globalDailyLimit, requestReuseLimit, requestCooldownMin, maxPendingPerUser, joinGateEnabled, joinGateChannel, joinGateInviteUrl]);

  const toggleRequireWorkerSecret = useCallback(
    async (next: boolean) => {
      setBusyAction("worker-secret");
      setError("");
      setNotice("");
      try {
        const res = await fetch(apiUrl("/api/admin/settings"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ requireWorkerSecret: next }),
        });
        const json = (await res.json()) as BotPanelResponse;
        if (!res.ok || !json.ok) throw new Error(json.error || `Save failed (${res.status}).`);
        setRequireWorkerSecret(Boolean(json.settings?.requireWorkerSecret ?? next));
        setNotice(
          next
            ? "Worker secret is now REQUIRED. Only deploy the updated worker.js (with WORKER_SHARED_SECRET pasted) before turning this on, or streaming will stop."
            : "Worker secret check turned OFF — the origin again trusts any request carrying X-SHD-Worker-Proxy."
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed.");
      } finally {
        setBusyAction("");
      }
    },
    []
  );

  const copyText = useCallback(async (label: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setCopied("");
    }
  }, []);

  const users = useMemo(() => data?.users || [], [data]);
  const stats = data?.stats || {};
  const workerSecret = data?.workerSecret || "";
  const botAlive = Boolean(stats.botAlive);

  const levelUpEveryone = useCallback(async () => {
    if (!users.length) return;
    const next = Math.max(0, dailyLimit + 1);
    const ok = window.confirm(
      `Raise the daily limit for all ${users.length} known users from ${dailyLimit} to ${next}?`
    );
    if (!ok) return;
    setBusyAction("level-all");
    setError("");
    let done = 0;
    for (const u of users) {
      if (!u.id) continue;
      const res = await post(
        { action: "set_user_limit", userId: u.id, limit: next },
        `level-${u.id}`
      );
      if (res) done += 1;
    }
    setBusyAction("");
    setNotice(`Updated ${done} user${done === 1 ? "" : "s"} to ${next} videos / 24h.`);
    await load();
  }, [users, dailyLimit, post, load]);

  const setSingleLimit = useCallback(
    async (uid: number, limit: number) => {
      if (!Number.isFinite(limit) || limit < 0) return;
      const res = await post({ action: "set_user_limit", userId: uid, limit }, `limit-${uid}`);
      if (res) {
        setNotice(`User ${uid} limit set to ${limit} videos / 24h.`);
        await load();
      }
    },
    [post, load]
  );

  const sendBroadcast = useCallback(async () => {
    const message = broadcast.trim();
    if (!message) {
      setError("Broadcast message is empty.");
      return;
    }
    const res = await post({ action: "broadcast", message }, "broadcast");
    if (res) {
      setNotice("Broadcast queued. The bot will send it to every known user.");
      setBroadcast("");
      await load();
    }
  }, [broadcast, post, load]);

  const togglePause = useCallback(async () => {
    const res = await post(
      {
        action: "save_config",
        config: {
          paused: !paused,
          pauseMessage: !paused
            ? "Bot delivery is paused by the admin right now. Please try again a little later."
            : "",
        },
      },
      "pause"
    );
    if (res) {
      setNotice(!paused ? "Bot delivery PAUSED." : "Bot delivery RESUMED.");
      setPaused(!paused);
      await load();
    }
  }, [paused, post, load]);

  if (loading) {
    return (
      <div className="glass-card rounded-3xl border border-white/10 p-10 text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-cyan-300" />
        <p className="mt-3 text-sm font-bold text-slate-300">Loading Telegram bot panel…</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ─────────────────────────── status strip ─────────────────────────── */}
      <div className="glass-card rounded-3xl border border-white/10 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl border ${
                botAlive
                  ? "border-emerald-400/35 bg-emerald-500/15 text-emerald-300"
                  : "border-rose-400/35 bg-rose-500/15 text-rose-300"
              }`}
            >
              <Bot className="h-6 w-6" />
            </span>
            <div>
              <h2 className="text-lg font-black text-white">Telegram Bot Delivery</h2>
              <p className="text-xs font-semibold text-slate-400">
                Bot{" "}
                <span className={botAlive ? "text-emerald-300" : "text-rose-300"}>
                  {botAlive ? "ONLINE" : "OFFLINE / not reporting"}
                </span>
                {stats.lastHeartbeatAt ? ` • last ping ${fmtAgo(stats.lastHeartbeatAt)}` : ""} •
                store: {String(stats.backend || "unknown")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={togglePause}
              disabled={Boolean(busyAction)}
              className={`inline-flex items-center gap-2 rounded-2xl border px-4 py-2.5 text-xs font-black uppercase tracking-wider transition ${
                paused
                  ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                  : "border-amber-400/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
              } disabled:opacity-50`}
            >
              {busyAction === "pause" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : paused ? (
                <Play className="h-4 w-4" />
              ) : (
                <Pause className="h-4 w-4" />
              )}
              {paused ? "Resume delivery" : "Pause delivery"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-2 rounded-2xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-slate-200 transition hover:bg-white/10"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>

        {error ? (
          <p className="mt-3 flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-xs font-semibold text-rose-200">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="mt-3 flex items-start gap-2 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs font-semibold text-emerald-200">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            {notice}
          </p>
        ) : null}
      </div>

      {/* ───────────────────────────── stats ──────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatTile label="Total users" value={stats.totalUsers ?? 0} icon={Users} tone="cyan" />
        <StatTile
          label="Videos sent (all time)"
          value={stats.totalVideosSent ?? 0}
          icon={Send}
          tone="emerald"
        />
        <StatTile
          label="Last 24h"
          value={stats.videosLast24h ?? 0}
          icon={TrendingUp}
          tone="purple"
        />
        <StatTile
          label="Auto-delete queue"
          value={stats.pendingDeletions ?? 0}
          icon={Clock}
          tone="amber"
        />
        <StatTile
          label="Default limit"
          value={`${stats.dailyLimit ?? dailyLimit} / 24h`}
          icon={Download}
          tone="rose"
        />
      </div>

      {/* ─────────────────────── delivery mode + config ───────────────────── */}
      <div className="glass-card rounded-3xl border border-white/10 p-4 sm:p-5">
        <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-white">
          <Activity className="h-4 w-4 text-cyan-300" />
          Delivery mode on the watch page
        </h3>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setMode("telegram-bot")}
            className={`rounded-3xl border p-4 text-left transition ${
              mode === "telegram-bot"
                ? "border-cyan-400/70 bg-cyan-500/10 shadow-glow-cyan"
                : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
            }`}
          >
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-cyan-300">
              <Send className="h-4 w-4" /> Telegram bot (recommended)
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              Watch page shows an &ldquo;Open Video in Telegram&rdquo; button. The bot finds the
              lecture across your channels and sends it privately, with a 2-hour
              auto-delete. No chunked streaming, no stutter.
            </p>
          </button>

          <button
            type="button"
            onClick={() => setMode("in-app-player")}
            className={`rounded-3xl border p-4 text-left transition ${
              mode === "in-app-player"
                ? "border-purple-400/70 bg-purple-500/10"
                : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
            }`}
          >
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-purple-300">
              <Play className="h-4 w-4" /> In-app player (legacy)
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              Old behaviour: video plays inside the website via Cloudflare Worker
              byte-range streaming. Keep this only as a fallback.
            </p>
          </button>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field
            label="Bot username"
            hint="The bot your deep links open, without @ (create it with @BotFather)."
          >
            <input
              className={inputCls}
              value={botUsername}
              onChange={(e) => setBotUsername(e.target.value)}
              placeholder="StudyHelperBot"
            />
          </Field>

          <Field
            label="Daily video limit (per user)"
            hint="Rolling 24-hour window. 12 = free plan. Change per user below."
          >
            <input
              className={inputCls}
              type="number"
              min={0}
              max={100000}
              value={dailyLimit}
              onChange={(e) => setDailyLimit(Number(e.target.value) || 0)}
            />
          </Field>

          <Field
            label="Auto-delete after (hours)"
            hint="The bot deletes each delivered file after this many hours and tells the user."
          >
            <input
              className={inputCls}
              type="number"
              min={0}
              max={720}
              value={autoDeleteHours}
              onChange={(e) => setAutoDeleteHours(Number(e.target.value) || 0)}
            />
          </Field>

          <Field label="Caption credit handle" hint="Shown as “Extracted By @handle” in the caption.">
            <input
              className={inputCls}
              value={creditUsername}
              onChange={(e) => setCreditUsername(e.target.value)}
              placeholder="krishna84"
            />
          </Field>

          <Field
            label="Contact handle for limit increase"
            hint="Sent when a user finishes their daily limit."
          >
            <input
              className={inputCls}
              value={contactUsername}
              onChange={(e) => setContactUsername(e.target.value)}
              placeholder="krishna84"
            />
          </Field>

          <Field
            label="Delivery method"
            hint="Clean = download + re-upload (source name never visible). Forward = only when the source allows it; auto-downgrades to clean otherwise."
          >
            <select
              className={inputCls}
              value={deliveryMode}
              onChange={(e) => setDeliveryMode(e.target.value === "forward" ? "forward" : "clean")}
            >
              <option value="clean">Clean re-upload (source hidden)</option>
              <option value="forward">Forward when allowed</option>
            </select>
          </Field>

          <Field label="Search: max dialogs" hint="How many of the account's chats the bot scans.">
            <input
              className={inputCls}
              type="number"
              min={5}
              max={500}
              value={maxDialogs}
              onChange={(e) => setMaxDialogs(Number(e.target.value) || 60)}
            />
          </Field>

          <Field label="Search: max messages per chat" hint="Deep-scan budget per channel.">
            <input
              className={inputCls}
              type="number"
              min={5}
              max={500}
              value={maxMessagesPerChat}
              onChange={(e) => setMaxMessagesPerChat(Number(e.target.value) || 40)}
            />
          </Field>

          <Field label="Deep-link validity (hours)" hint="How long a generated request link works.">
            <input
              className={inputCls}
              type="number"
              min={1}
              max={2160}
              value={requestTtlHours}
              onChange={(e) => setRequestTtlHours(Number(e.target.value) || 168)}
            />
          </Field>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={() => void saveConfig()}
            disabled={saving || Boolean(busyAction)}
            className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-500 via-indigo-500 to-purple-600 px-5 py-3 text-xs font-black uppercase tracking-widest text-white shadow-glow-cyan transition hover:brightness-110 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save bot configuration
          </button>
        </div>
      </div>

      {/* ────────────────────── 🛡️ anti-theft / fair use ──────────────────── */}
      <div className="glass-card rounded-3xl border border-emerald-400/25 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-white">
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              Anti-theft &amp; fair use
            </h3>
            <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-slate-400">
              Stops anyone from scraping the whole course. Each deep link is
              single-use, binds to the first Telegram account that opens it, and
              the website enforces the same daily limit as the bot (plus its own
              per-user and per-IP throttles). The global breaker caps total
              videos delivered per 24h across the entire site.
            </p>
          </div>
          {globalQuota ? (
            <div
              className={`rounded-2xl border px-3.5 py-2.5 text-right ${
                globalQuota.tripped
                  ? "border-rose-400/40 bg-rose-500/10"
                  : "border-emerald-400/30 bg-emerald-500/10"
              }`}
            >
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                Site usage (24h)
              </p>
              <p
                className={`text-lg font-black ${
                  globalQuota.tripped ? "text-rose-200" : "text-emerald-200"
                }`}
              >
                {globalQuota.used}
                {globalQuota.limit > 0 ? ` / ${globalQuota.limit}` : ""}
              </p>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {globalQuota.tripped
                  ? "breaker TRIPPED"
                  : globalQuota.limit > 0
                    ? `${globalQuota.remaining} left`
                    : "breaker off"}
              </p>
            </div>
          ) : null}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field
            label="Global videos / 24h (whole site)"
            hint="Circuit breaker. 0 = off. Set it a little above your real daily traffic so a scraper cannot drain everything."
          >
            <input
              className={inputCls}
              type="number"
              min={0}
              max={1000000}
              value={globalDailyLimit}
              onChange={(e) => setGlobalDailyLimit(Number(e.target.value) || 0)}
            />
          </Field>

          <Field
            label="Uses per link"
            hint="1 = single-use deep link (recommended). The bot deletes the request after delivery."
          >
            <input
              className={inputCls}
              type="number"
              min={1}
              max={50}
              value={requestReuseLimit}
              onChange={(e) => setRequestReuseLimit(Number(e.target.value) || 1)}
            />
          </Field>

          <Field
            label="Same-video cooldown (minutes)"
            hint="Re-tapping the same lecture reuses the existing link instead of creating a new one and spending quota twice."
          >
            <input
              className={inputCls}
              type="number"
              min={0}
              max={1440}
              value={requestCooldownMin}
              onChange={(e) => setRequestCooldownMin(Number(e.target.value) || 0)}
            />
          </Field>

          <Field
            label="Max pending links per user"
            hint="How many undelivered links one user can hold at once. Stops bulk link farming."
          >
            <input
              className={inputCls}
              type="number"
              min={1}
              max={100}
              value={maxPendingPerUser}
              onChange={(e) => setMaxPendingPerUser(Number(e.target.value) || 3)}
            />
          </Field>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-2 text-[11px] font-semibold text-slate-400 sm:grid-cols-2">
          <p className="rounded-2xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <span className="text-emerald-300">Built-in throttles:</span> 15 links
            / 10 min per login and 30 / 10 min per IP, both DB-backed so they
            hold across every serverless container.
          </p>
          <p className="rounded-2xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <span className="text-emerald-300">Binding:</span> the first Telegram
            account to open a link owns it; anyone else gets “This link belongs
            to another account.”
          </p>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => void saveConfig()}
            disabled={saving || Boolean(busyAction)}
            className="inline-flex items-center gap-2 rounded-2xl border border-emerald-400/40 bg-emerald-500/15 px-5 py-3 text-xs font-black uppercase tracking-widest text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save anti-theft settings
          </button>
        </div>
      </div>

      {/* ───────────────────── 🔒 channel join-gate ─────────────────────── */}
      <div className="glass-card rounded-3xl border border-sky-400/25 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-white">
              <Radio className="h-4 w-4 text-sky-300" />
              Channel join gate
            </h3>
            <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-slate-400">
              When this is ON, a student must join your Telegram channel before
              the bot sends any video. The bot replies with a “Join our channel”
              button plus an “I have joined” button that verifies membership
              live. The deep link is <span className="text-slate-300">not</span>{" "}
              consumed and no quota is spent while the student is blocked, so
              nothing is lost.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setJoinGateEnabled((v) => !v)}
            className={`relative h-8 w-16 shrink-0 rounded-full border transition ${
              joinGateEnabled
                ? "border-sky-400/60 bg-sky-500/35"
                : "border-white/15 bg-white/[0.06]"
            }`}
            aria-pressed={joinGateEnabled}
            title={joinGateEnabled ? "Join gate is ON" : "Join gate is OFF"}
          >
            <span
              className={`absolute top-1 h-6 w-6 rounded-full transition-all ${
                joinGateEnabled ? "left-9 bg-sky-300" : "left-1 bg-slate-500"
              }`}
            />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Channel to verify (@username or chat id)"
            hint="The bot must be an ADMIN of this channel, otherwise Telegram refuses the member lookup and the gate fails OPEN (students still get their videos; you will see a warning in the bot log)."
          >
            <input
              className={inputCls}
              type="text"
              spellCheck={false}
              placeholder="@your_channel  or  -1001234567890"
              value={joinGateChannel}
              onChange={(e) => setJoinGateChannel(e.target.value)}
            />
          </Field>

          <Field
            label="Invite link for the button (optional)"
            hint="Leave empty to auto-build https://t.me/<username>. Use a private t.me/+… invite link here if your channel is private."
          >
            <input
              className={inputCls}
              type="text"
              spellCheck={false}
              placeholder="https://t.me/+AbCdEfGhIjKlMnOp"
              value={joinGateInviteUrl}
              onChange={(e) => setJoinGateInviteUrl(e.target.value)}
            />
          </Field>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-2 text-[11px] font-semibold text-slate-400 sm:grid-cols-2">
          <p className="rounded-2xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <span className="text-sky-300">How the check works:</span> the bot asks
            Telegram for the member list entry of that user (bot session first,
            then the user session). Confirmed members are cached for 10 minutes
            so repeat requests are instant.
          </p>
          <p className="rounded-2xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <span className="text-sky-300">Order of checks:</span> join gate →
            anti-theft gate → daily quota → search &amp; deliver. A blocked
            student never burns a link or a quota slot.
          </p>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => void saveConfig()}
            disabled={saving || Boolean(busyAction)}
            className="inline-flex items-center gap-2 rounded-2xl border border-sky-400/40 bg-sky-500/15 px-5 py-3 text-xs font-black uppercase tracking-widest text-sky-100 transition hover:bg-sky-500/25 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save join-gate settings
          </button>
        </div>
      </div>

      {/* ───────────────────────── worker secret ──────────────────────────── */}
      <div className="glass-card rounded-3xl border border-white/10 p-4 sm:p-5">
        <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-white">
          <Shield className="h-4 w-4 text-emerald-300" />
          Cloudflare Worker ⇄ origin shared secret
        </h3>
        <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-slate-400">
          Derived from your <code className="text-slate-300">ADMIN_SESSION_SECRET</code> (HMAC-SHA256,
          label <code className="text-slate-300">shd_cloudflare_worker_v1</code>). Paste it into{" "}
          <code className="text-slate-300">WORKER_SHARED_SECRET</code> at the top of{" "}
          <code className="text-slate-300">cloudflare-worker/worker.js</code>, redeploy the worker,
          and only then turn enforcement ON. The worker now sends it as the{" "}
          <code className="text-slate-300">X-Worker-Secret</code> header.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <code className="max-w-full flex-1 truncate rounded-2xl border border-white/15 bg-[#060919] px-4 py-3 font-mono text-[11px] text-cyan-200">
            {workerSecret || "—"}
          </code>
          <button
            type="button"
            onClick={() => void copyText("worker-secret", workerSecret)}
            className="inline-flex items-center gap-2 rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-xs font-black uppercase tracking-wider text-slate-200 transition hover:bg-white/10"
          >
            {copied === "worker-secret" ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-300" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {copied === "worker-secret" ? "Copied" : "Copy"}
          </button>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-emerald-400"
            checked={requireWorkerSecret}
            disabled={busyAction === "worker-secret"}
            onChange={(e) => void toggleRequireWorkerSecret(e.target.checked)}
          />
          <span>
            <span className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-emerald-300">
              <ShieldCheck className="h-4 w-4" /> Require worker secret on stream requests
            </span>
            <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">
              OFF (default) = the origin trusts any request carrying the worker proxy header, so an
              old deployed worker keeps working. ON = the header alone is rejected and the secret is
              verified with a timing-safe compare. Turn ON only after the updated worker is live.
            </span>
          </span>
        </label>
      </div>

      {/* ──────────────────────────── users ───────────────────────────────── */}
      <div className="glass-card rounded-3xl border border-white/10 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-white">
            <Users className="h-4 w-4 text-purple-300" />
            Bot users ({users.length})
          </h3>
          <button
            type="button"
            onClick={() => void levelUpEveryone()}
            disabled={Boolean(busyAction) || users.length === 0}
            className="inline-flex items-center gap-2 rounded-2xl border border-emerald-400/40 bg-emerald-500/15 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-emerald-200 transition hover:bg-emerald-500/25 disabled:opacity-40"
          >
            {busyAction === "level-all" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <TrendingUp className="h-4 w-4" />
            )}
            Level up everyone (+1)
          </button>
        </div>

        {users.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs font-semibold text-slate-400">
            No user has opened a delivery deep link yet. As soon as someone taps
            &ldquo;Open Video in Telegram&rdquo; and starts the bot, they appear here.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="border-b border-white/10 text-[10px] font-black uppercase tracking-widest text-slate-500">
                  <th className="py-2.5 pr-3">User</th>
                  <th className="py-2.5 pr-3">Telegram ID</th>
                  <th className="py-2.5 pr-3">Sent</th>
                  <th className="py-2.5 pr-3">Used (24h)</th>
                  <th className="py-2.5 pr-3">Last seen</th>
                  <th className="py-2.5 pr-3">Limit / 24h</th>
                  <th className="py-2.5">Quick adjust</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const used = (u.recent || []).length;
                  const limit = Number(u.limit ?? dailyLimit);
                  return (
                    <tr key={String(u.id)} className="border-b border-white/[0.06] text-slate-300">
                      <td className="py-2.5 pr-3 font-bold text-white">
                        {userLabel(u)}
                        {u.banned ? (
                          <span className="ml-2 rounded-lg border border-rose-400/40 bg-rose-500/15 px-1.5 py-0.5 text-[9px] font-black uppercase text-rose-200">
                            banned
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-3 font-mono">{u.id ?? "—"}</td>
                      <td className="py-2.5 pr-3">{u.totalVideos ?? 0}</td>
                      <td className="py-2.5 pr-3">
                        {used} / {limit}
                      </td>
                      <td className="py-2.5 pr-3">{fmtAgo(u.lastSeen)}</td>
                      <td className="py-2.5 pr-3">
                        <input
                          type="number"
                          min={0}
                          max={100000}
                          className="w-24 rounded-xl border border-white/15 bg-[#060919] px-2.5 py-1.5 text-xs font-bold text-white outline-none focus:border-cyan-400"
                          defaultValue={limit}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" || !u.id) return;
                            const v = Number((e.target as HTMLInputElement).value);
                            void setSingleLimit(u.id, Math.max(0, Math.round(v) || 0));
                          }}
                          onBlur={(e) => {
                            if (!u.id) return;
                            const v = Number(e.target.value);
                            if (Math.max(0, Math.round(v) || 0) === limit) return;
                            void setSingleLimit(u.id, Math.max(0, Math.round(v) || 0));
                          }}
                        />
                      </td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-1.5">
                          {[-1, +1, +5].map((delta) => (
                            <button
                              key={delta}
                              type="button"
                              disabled={Boolean(busyAction) || !u.id}
                              onClick={() =>
                                u.id
                                  ? void setSingleLimit(
                                      u.id,
                                      Math.max(0, Math.round(limit + delta))
                                    )
                                  : undefined
                              }
                              className="rounded-xl border border-white/15 bg-white/5 px-2.5 py-1.5 text-[10px] font-black text-slate-200 transition hover:bg-white/10 disabled:opacity-40"
                            >
                              {delta > 0 ? `+${delta}` : delta}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─────────────────────────── broadcast ────────────────────────────── */}
      <div className="glass-card rounded-3xl border border-white/10 p-4 sm:p-5">
        <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-white">
          <Send className="h-4 w-4 text-cyan-300" />
          Broadcast to all bot users
        </h3>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          Written in English, delivered by the bot to every known user (rate-limited by Telegram to
          ~30 messages/second). Queued instantly; the bot picks it up on its next tick.
        </p>
        <textarea
          className={`${inputCls} mt-3 min-h-[96px] resize-y`}
          value={broadcast}
          onChange={(e) => setBroadcast(e.target.value)}
          placeholder="New lectures are live in your course. Tap Open Video in Telegram on the lecture page to receive your file."
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
            {broadcast.length} / 3800 characters
          </span>
          <button
            type="button"
            onClick={() => void sendBroadcast()}
            disabled={busyAction === "broadcast" || !broadcast.trim()}
            className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-500 to-purple-600 px-5 py-3 text-xs font-black uppercase tracking-widest text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {busyAction === "broadcast" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Send broadcast
          </button>
        </div>
      </div>

      {/* ─────────────────────── events + task queue ──────────────────────── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="glass-card rounded-3xl border border-white/10 p-4 sm:p-5">
          <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-white">
            <Activity className="h-4 w-4 text-emerald-300" />
            Recent bot events
          </h3>
          <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
            {(data?.events || []).length === 0 ? (
              <p className="text-xs font-semibold text-slate-500">No events recorded yet.</p>
            ) : (
              (data?.events || []).map((ev, i) => (
                <div
                  key={i}
                  className="rounded-2xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-black uppercase tracking-wider text-cyan-300">
                      {String(ev.type || ev.event || "event")}
                    </span>
                    <span className="text-[10px] font-semibold text-slate-500">
                      {fmtTime(Number(ev.at || ev.timestamp || ev.time || 0))}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-[11px] font-medium text-slate-400">
                    {String(ev.message || ev.detail || ev.text || "")}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="glass-card rounded-3xl border border-white/10 p-4 sm:p-5">
          <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-white">
            <Clock className="h-4 w-4 text-amber-300" />
            Task queue (website → bot)
          </h3>
          <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
            {(data?.tasks || []).length === 0 ? (
              <p className="text-xs font-semibold text-slate-500">Queue is empty.</p>
            ) : (
              (data?.tasks || []).map((t, i) => (
                <div
                  key={String(t.id || i)}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5"
                >
                  <div>
                    <span className="text-xs font-black uppercase tracking-wider text-purple-300">
                      {String(t.type || "task")}
                    </span>
                    <span className="ml-2 text-[10px] font-semibold text-slate-500">
                      {fmtTime(Number(t.createdAt || 0))}
                    </span>
                  </div>
                  <span
                    className={`rounded-lg border px-2 py-0.5 text-[9px] font-black uppercase ${
                      t.status === "done"
                        ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                        : "border-amber-400/40 bg-amber-500/15 text-amber-200"
                    }`}
                  >
                    {String(t.status || "pending")}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <p className="px-1 pb-2 text-[10px] leading-relaxed text-slate-500">
        The Python bot itself (<code>telegram-bot/bot.py</code>) runs on your own server — Vercel
        only stores requests, config and stats in Firebase RTDB. See{" "}
        <code>telegram-bot/README.md</code> for hosting steps.
      </p>
    </div>
  );
}
