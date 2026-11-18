"use client";

/**
 * 🧹 Telegram Purge — "Telegram se jo bhi aaya, wo sab hata do"
 * ---------------------------------------------------------------------------
 * Admin ka ek hi button jo SIRF Telegram-sourced data hatata hai:
 *   • Telegram video/PDF links (tg_video_token / tg_pdf_token / tg_attached)
 *   • Sync se bane nodes (tgv_* / tgp_*)                [optional]
 *   • Sync se bane poore courses (telegram_auto_sync)    [optional]
 *   • Synced Telegram Groups registry
 *   • Bot delivery requests (tg_requests)
 *   • Telegram-derived video embeds
 *   • Bot user/quota state                               [optional]
 *
 * KABHI NAHI hat-ta: data/batches/*.json (real/original courses), manually
 * uploaded courses, YouTube links, student accounts, site settings, bot config.
 *
 * Flow: SCAN (read-only preview) → scope select → type DELETE → PURGE.
 */

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Eraser,
  FileWarning,
  Link2Off,
  Loader2,
  RefreshCw,
  Shield,
  Trash2,
} from "lucide-react";

interface CourseInfo {
  id: string;
  name: string;
  source: string;
  fileBacked: boolean;
  telegramVideos: number;
  telegramPdfs: number;
  syncNodes: number;
  totalNodes: number;
}

interface PurgePreview {
  scannedCourses: number;
  telegramCourses: CourseInfo[];
  affectedCourses: CourseInfo[];
  nodesWithTelegramVideo: number;
  nodesWithTelegramPdf: number;
  nodesCreatedBySync: number;
  groupRegistryRecords: number;
  groupRegistrySample: string[];
  pendingRequests: number;
  telegramEmbedEntries: number;
  botUsers: number;
  botDeletionQueue: number;
  protectedSummary: {
    fileBackedCourses: number;
    manualCourses: number;
    youtubeLinks: number;
    botConfigKept: boolean;
    studentAccountsKept: boolean;
    siteSettingsKept: boolean;
  };
  ranAt: string;
}

interface PurgeApplied {
  coursesStripped: number;
  coursesDeleted: number;
  nodesStripped: number;
  nodesDeleted: number;
  groupRecordsDeleted: number;
  requestsDeleted: number;
  embedsDeleted: number;
  botUsersDeleted: number;
  botDeletionsDeleted: number;
}

interface PurgeOptions {
  stripLinks: boolean;
  deleteTelegramNodes: boolean;
  deleteTelegramCourses: boolean;
  clearGroupRegistry: boolean;
  clearRequests: boolean;
  clearEmbeds: boolean;
  clearBotState: boolean;
}

const DEFAULT_OPTIONS: PurgeOptions = {
  stripLinks: true,
  deleteTelegramNodes: false,
  deleteTelegramCourses: false,
  clearGroupRegistry: true,
  clearRequests: true,
  clearEmbeds: true,
  clearBotState: false,
};

function apiUrl(path: string) {
  if (typeof window === "undefined") return path;
  const base = String(process.env.NEXT_PUBLIC_SITE_URL || window.location.origin);
  return `${base.replace(/\/$/, "")}${path}`;
}

function Row({
  icon: Icon,
  label,
  value,
  tone = "slate",
}: {
  icon: typeof Database;
  label: string;
  value: string | number;
  tone?: "slate" | "rose" | "emerald" | "amber";
}) {
  const toneMap: Record<string, string> = {
    slate: "text-slate-200",
    rose: "text-rose-300",
    emerald: "text-emerald-300",
    amber: "text-amber-300",
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
      <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className={`text-sm font-black ${toneMap[tone]}`}>{value}</span>
    </div>
  );
}

export default function TelegramPurgePanel({ onPurged }: { onPurged?: () => void }) {
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [purging, setPurging] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [options, setOptions] = useState<PurgeOptions>(DEFAULT_OPTIONS);
  const [applied, setApplied] = useState<PurgeApplied | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    setError("");
    setNotice("");
    setApplied(null);
    try {
      const res = await fetch(apiUrl("/api/admin/telegram/purge"), {
        cache: "no-store",
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `Scan failed (${res.status}).`);
      setPreview(json.preview as PurgePreview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed.");
      setPreview(null);
    } finally {
      setScanning(false);
    }
  }, []);

  const runPurge = useCallback(async () => {
    if (confirmText.trim() !== "DELETE") {
      setError('Type DELETE in the confirmation box first.');
      return;
    }
    if (!Object.values(options).some(Boolean)) {
      setError("Select at least one thing to delete.");
      return;
    }
    setPurging(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(apiUrl("/api/admin/telegram/purge"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ confirmText: confirmText.trim(), options }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `Purge failed (${res.status}).`);
      const result = json.result as { applied: PurgeApplied; errors?: string[] };
      setApplied(result.applied);
      setPreview(json.result as PurgePreview);
      setConfirmText("");
      setNotice(
        `Purge complete. ${result.applied.coursesDeleted} course(s) deleted, ${result.applied.coursesStripped} course(s) cleaned, ${result.applied.requestsDeleted} delivery request(s) removed.`
      );
      onPurged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Purge failed.");
    } finally {
      setPurging(false);
    }
  }, [confirmText, options, onPurged]);

  const toggle = (key: keyof PurgeOptions) =>
    setOptions((o) => ({ ...o, [key]: !o[key] }));

  const scopeItems: Array<{
    key: keyof PurgeOptions;
    title: string;
    desc: string;
    danger?: boolean;
  }> = [
    {
      key: "stripLinks",
      title: "Remove Telegram video / PDF links",
      desc: "Deletes tg_video_token, tg_pdf_token and “tg_attached” from every lecture. The course and its folders stay — those lectures then show the English “content unavailable” card.",
    },
    {
      key: "deleteTelegramNodes",
      title: "Delete lectures created by Telegram sync",
      desc: "Removes nodes the sync itself created (ids tgv_* / tgp_*). Manually added lectures are never touched.",
      danger: true,
    },
    {
      key: "deleteTelegramCourses",
      title: "Delete whole Telegram-synced courses",
      desc: "Deletes courses whose source is telegram_auto_sync. Courses that exist as real files in data/batches are NEVER deleted — only their links get stripped.",
      danger: true,
    },
    {
      key: "clearGroupRegistry",
      title: "Clear the Synced Telegram Groups list",
      desc: "Empties the group registry shown above (group names, sync status, counts).",
    },
    {
      key: "clearRequests",
      title: "Clear pending bot delivery requests",
      desc: "Deletes tg_requests/* — deep links already generated stop working immediately.",
    },
    {
      key: "clearEmbeds",
      title: "Clear Telegram-derived video embeds",
      desc: "Removes embed entries that point at /api/tg/stream/ tokens. YouTube embeds are kept.",
    },
    {
      key: "clearBotState",
      title: "Reset bot users, quota and stats",
      desc: "Wipes bot_state users / quota / stats / deletion queue. Bot configuration (username, limits) is always kept.",
      danger: true,
    },
  ];

  return (
    <div className="glass-card rounded-3xl border border-rose-400/30 p-4 sm:p-6">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-rose-400/40 bg-rose-500/15 text-rose-300">
            <Eraser className="h-6 w-6" />
          </span>
          <div>
            <h2 className="text-lg font-black text-white">
              Danger Zone — Remove everything that came from Telegram
            </h2>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-400">
              One button to wipe every Telegram-sourced link, lecture, synced
              course, group record and delivery request. Your real uploaded data
              is protected: original course files in <code>data/batches</code>,
              manually uploaded courses, YouTube links, student accounts, site
              settings and the bot configuration are never touched.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void scan()}
          disabled={scanning || purging}
          className="inline-flex items-center gap-2 rounded-2xl border border-white/15 bg-white/5 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
        >
          {scanning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Scan now
        </button>
      </div>

      {error ? (
        <p className="mt-4 flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-xs font-semibold text-rose-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs font-semibold text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          {notice}
        </p>
      ) : null}

      {/* preview */}
      {preview ? (
        <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-rose-300">
              Will be removed
            </p>
            <Row
              icon={Link2Off}
              label="Telegram video links"
              value={preview.nodesWithTelegramVideo}
              tone="rose"
            />
            <Row
              icon={Link2Off}
              label="Telegram PDF links"
              value={preview.nodesWithTelegramPdf}
              tone="rose"
            />
            <Row
              icon={FileWarning}
              label="Lectures created by sync"
              value={preview.nodesCreatedBySync}
              tone="rose"
            />
            <Row
              icon={Database}
              label="Synced group records"
              value={preview.groupRegistryRecords}
              tone="rose"
            />
            <Row
              icon={Trash2}
              label="Pending delivery requests"
              value={preview.pendingRequests}
              tone="rose"
            />
          </div>

          <div className="space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-amber-300">
              Courses involved
            </p>
            <Row
              icon={Database}
              label="Courses scanned"
              value={preview.scannedCourses}
            />
            <Row
              icon={Database}
              label="Fully Telegram-synced"
              value={preview.telegramCourses.length}
              tone="amber"
            />
            <Row
              icon={Database}
              label="Containing Telegram links"
              value={preview.affectedCourses.length}
              tone="amber"
            />
            <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
              {preview.affectedCourses.slice(0, 12).map((c) => (
                <div
                  key={c.id}
                  className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px]"
                >
                  <span className="font-bold text-white">{c.name}</span>
                  <span className="ml-2 text-slate-500">#{c.id}</span>
                  <div className="mt-0.5 text-[10px] text-slate-400">
                    {c.telegramVideos} video link{c.telegramVideos === 1 ? "" : "s"} •{" "}
                    {c.telegramPdfs} pdf link{c.telegramPdfs === 1 ? "" : "s"} • source{" "}
                    {c.source}
                    {c.fileBacked ? " • file-backed (protected)" : ""}
                  </div>
                </div>
              ))}
              {preview.affectedCourses.length === 0 ? (
                <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-semibold text-slate-400">
                  No Telegram-sourced content found. Nothing to delete.
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-emerald-300">
              Always protected
            </p>
            <Row
              icon={Shield}
              label="Original course files"
              value={preview.protectedSummary.fileBackedCourses}
              tone="emerald"
            />
            <Row
              icon={Shield}
              label="Manual / non-Telegram courses"
              value={preview.protectedSummary.manualCourses}
              tone="emerald"
            />
            <Row
              icon={Shield}
              label="YouTube links kept"
              value={preview.protectedSummary.youtubeLinks}
              tone="emerald"
            />
            <Row
              icon={Shield}
              label="Student accounts & settings"
              value="kept"
              tone="emerald"
            />
            <Row icon={Shield} label="Bot configuration" value="kept" tone="emerald" />
          </div>
        </div>
      ) : (
        <p className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-xs font-semibold text-slate-400">
          Press <span className="text-white">Scan now</span> to see exactly what
          will be deleted before you confirm anything. Scanning changes nothing.
        </p>
      )}

      {/* result of last purge */}
      {applied ? (
        <div className="mt-5 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-emerald-300">
            Last purge result
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] font-semibold text-emerald-100 sm:grid-cols-3">
            <span>Courses cleaned: {applied.coursesStripped}</span>
            <span>Courses deleted: {applied.coursesDeleted}</span>
            <span>Links stripped: {applied.nodesStripped}</span>
            <span>Lectures removed: {applied.nodesDeleted}</span>
            <span>Group records: {applied.groupRecordsDeleted}</span>
            <span>Requests: {applied.requestsDeleted}</span>
            <span>Embeds: {applied.embedsDeleted}</span>
            <span>Bot users reset: {applied.botUsersDeleted}</span>
          </div>
        </div>
      ) : null}

      {/* scope */}
      <div className="mt-6 space-y-2.5">
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
          What should be deleted
        </p>
        {scopeItems.map((item) => (
          <label
            key={item.key}
            className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3.5 transition ${
              options[item.key]
                ? item.danger
                  ? "border-rose-400/50 bg-rose-500/10"
                  : "border-cyan-400/40 bg-cyan-500/10"
                : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-rose-400"
              checked={options[item.key]}
              disabled={purging}
              onChange={() => toggle(item.key)}
            />
            <span>
              <span
                className={`text-xs font-black uppercase tracking-wider ${
                  item.danger ? "text-rose-200" : "text-cyan-200"
                }`}
              >
                {item.title}
              </span>
              <span className="mt-1 block text-[11px] leading-relaxed text-slate-400">
                {item.desc}
              </span>
            </span>
          </label>
        ))}
      </div>

      {/* confirm */}
      <div className="mt-6 rounded-3xl border border-rose-400/40 bg-rose-500/[0.07] p-4">
        <p className="text-xs font-black uppercase tracking-widest text-rose-200">
          Type DELETE to confirm
        </p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-rose-200/70">
          This cannot be undone. Deep links already sent to users stop working
          immediately, and lectures without a Telegram file will show the
          “content unavailable” card until you sync them again.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="DELETE"
            disabled={purging}
            className="w-40 rounded-2xl border border-rose-400/40 bg-[#12060c] px-4 py-2.5 text-sm font-black tracking-widest text-rose-100 outline-none focus:border-rose-300"
          />
          <button
            type="button"
            onClick={() => void runPurge()}
            disabled={purging || confirmText.trim() !== "DELETE"}
            className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-rose-600 to-red-600 px-5 py-3 text-xs font-black uppercase tracking-widest text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {purging ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {purging ? "Deleting…" : "Delete Telegram data"}
          </button>
        </div>
      </div>
    </div>
  );
}
