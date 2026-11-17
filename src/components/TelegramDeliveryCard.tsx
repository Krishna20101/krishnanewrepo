"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Loader2,
  Play,
  Send,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import SafeImage from "@/components/SafeImage";
import { apiUrl } from "@/config/siteConfig";

// ============================================================================
// 🤖 TELEGRAM DELIVERY CARD  (v5 — video player ki jagah)
// ----------------------------------------------------------------------------
// Purana flow: video Vercel/Cloudflare se chunk-stream hoti thi → "jhal-jhal",
// 1-2 second aage-peeche, frame jump (user ka sir chakra jata tha).
//
// Naya flow: yahan ek phone mockup + ▶ OPEN IN TELEGRAM button hai. Tap karte
// hi server ek one-time deep-link banata hai (POST /api/tg/request) aur
// `https://t.me/<bot>?start=<id>` khul jata hai. Bot wo lecture aapke
// Telegram par download + upload kar deta hai (live progress ke saath),
// 2 ghante baad auto-delete, aur daily limit ke andar.
//
// Saara user-facing text ENGLISH me hai (project rule).
// ============================================================================

type CardStatus = "idle" | "linking" | "ready" | "error";

export interface TelegramDeliveryCardProps {
  batchId: string;
  videoId: string;
  title: string;
  topic?: string;
  courseName?: string;
  thumbnail?: string;
  defaultImage?: string;
  fileSize?: number;
  botUsername?: string;
  dailyLimit?: number;
  autoDeleteHours?: number;
  creditUsername?: string;
  contactUsername?: string;
  paused?: boolean;
  /** Admin ne in-app player allow kiya ho to subtle fallback link dikhta hai */
  fallbackStreamUrl?: string;
  onUseFallback?: () => void;
}

function formatSize(bytes?: number): string {
  const size = Number(bytes || 0);
  if (!size) return "";
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function TelegramDeliveryCard({
  batchId,
  videoId,
  title,
  topic,
  courseName,
  thumbnail,
  defaultImage,
  fileSize,
  botUsername,
  dailyLimit = 12,
  autoDeleteHours = 2,
  creditUsername = "krishna84",
  contactUsername = "krishna84",
  paused = false,
  fallbackStreamUrl,
  onUseFallback,
}: TelegramDeliveryCardProps) {
  const [status, setStatus] = useState<CardStatus>("idle");
  const [deepLink, setDeepLink] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const busyRef = useRef(false);

  useEffect(() => {
    // Naye lecture par state reset
    setStatus("idle");
    setDeepLink("");
    setError("");
    setNotice("");
    setCopied(false);
    busyRef.current = false;
  }, [batchId, videoId]);

  const openTelegram = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStatus("linking");
    setError("");
    setNotice("");

    try {
      const res = await fetch(apiUrl("/api/tg/request"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId, videoId }),
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data?.ok || !data?.deepLink) {
        setStatus("error");
        setError(
          String(
            data?.error || "Could not create your Telegram link. Please try again."
          )
        );
        return;
      }

      setDeepLink(String(data.deepLink));
      setStatus("ready");

      if (data.isYoutubeOnly) {
        setNotice(
          "This lecture is a YouTube class — it plays inside the website. No Telegram delivery needed."
        );
      }

      // Popup blocker se bachne ke liye pehle blank tab, phir location set
      const win =
        typeof window !== "undefined"
          ? window.open("", "_blank", "noopener,noreferrer")
          : null;
      if (win) {
        win.opener = null;
        win.location.href = String(data.deepLink);
      } else if (typeof window !== "undefined") {
        window.location.href = String(data.deepLink);
      }
    } catch {
      setStatus("error");
      setError("Network error while creating your Telegram link. Please try again.");
    } finally {
      busyRef.current = false;
    }
  }, [batchId, videoId]);

  const copyLink = useCallback(async () => {
    if (!deepLink) return;
    try {
      await navigator.clipboard.writeText(deepLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  }, [deepLink]);

  const sizeText = formatSize(fileSize);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[#05070f] p-4">
      {/* Ambient glow + thumbnail blur */}
      <SafeImage
        src={thumbnail}
        fallbackSrc={defaultImage}
        alt={title}
        className="absolute inset-0 h-full w-full object-cover opacity-15 blur-[2px]"
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#05070f]/60 via-[#05070f]/85 to-[#05070f]" />

      <div className="relative z-10 flex w-full max-w-lg flex-col items-center gap-4">
        {/* ── PHONE MOCKUP (tap target) ─────────────────────────────────── */}
        <button
          type="button"
          onClick={openTelegram}
          disabled={status === "linking" || paused}
          aria-label="Open in Telegram"
          className="group relative w-[170px] shrink-0 rounded-[26px] border border-cyan-400/30 bg-gradient-to-b from-[#0b1130] to-[#070a1c] p-2.5 shadow-[0_0_40px_-12px_rgba(34,211,238,0.55)] transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-70 sm:w-[190px]"
        >
          <span className="mx-auto mb-2 block h-1.5 w-12 rounded-full bg-white/15" />
          <span className="relative flex aspect-[9/16] w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-[18px] bg-[#0a0f26]">
            {/* pulse rings */}
            <span className="pointer-events-none absolute h-24 w-24 animate-ping rounded-full bg-sky-500/20" />
            <span className="pointer-events-none absolute h-16 w-16 rounded-full bg-sky-500/25 blur-md" />

            <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-[#2AABEE] to-[#229ED9] shadow-lg">
              {status === "linking" ? (
                <Loader2 className="h-7 w-7 animate-spin text-white" />
              ) : status === "ready" ? (
                <CheckCircle2 className="h-7 w-7 text-white" />
              ) : (
                <Send className="h-6 w-6 translate-x-[1px] text-white" />
              )}
            </span>

            <span className="relative px-3 text-center text-[11px] font-black uppercase tracking-[0.16em] text-cyan-200">
              {status === "linking"
                ? "Creating link…"
                : status === "ready"
                  ? "Tap again to reopen"
                  : "Open in Telegram"}
            </span>
            <span className="relative px-3 text-center text-[10px] font-semibold leading-snug text-slate-400">
              {paused
                ? "Delivery paused by admin"
                : "Video will arrive in your Telegram chat"}
            </span>
          </span>
          <span className="mx-auto mt-2 block h-1 w-16 rounded-full bg-white/10" />
        </button>

        {/* ── PRIMARY ACTION ────────────────────────────────────────────── */}
        <div className="w-full space-y-2.5">
          <button
            type="button"
            onClick={openTelegram}
            disabled={status === "linking" || paused}
            className="flex w-full items-center justify-center gap-2.5 rounded-2xl bg-gradient-to-r from-[#2AABEE] to-[#229ED9] px-5 py-3.5 text-sm font-black uppercase tracking-wider text-white shadow-[0_10px_30px_-10px_rgba(42,171,238,0.8)] transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status === "linking" ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Send className="h-5 w-5" />
            )}
            <span>
              {status === "linking"
                ? "Opening Telegram…"
                : status === "ready"
                  ? "Open Video in Telegram"
                  : "Open in Telegram"}
            </span>
          </button>

          {deepLink && (
            <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-[11px] font-semibold text-cyan-200">
                {deepLink}
              </code>
              <button
                type="button"
                onClick={copyLink}
                className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-white/15 bg-white/5 px-2.5 py-1.5 text-[10px] font-black uppercase text-slate-200 active:scale-95"
              >
                {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
              <a
                href={deepLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-2.5 py-1.5 text-[10px] font-black uppercase text-cyan-100 active:scale-95"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>Open</span>
              </a>
            </div>
          )}

          {status === "error" && error && (
            <div className="flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
              <p className="text-[11px] font-semibold leading-relaxed text-rose-100">
                {error}
                {botUsername ? "" : " Ask the admin to start the delivery bot once."}
              </p>
            </div>
          )}

          {notice && (
            <div className="flex items-start gap-2 rounded-2xl border border-amber-400/30 bg-amber-500/10 px-3.5 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <p className="text-[11px] font-semibold leading-relaxed text-amber-100">{notice}</p>
            </div>
          )}

          {status === "ready" && !notice && (
            <div className="flex items-start gap-2 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 px-3.5 py-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
              <p className="text-[11px] font-semibold leading-relaxed text-emerald-100">
                Telegram opened. The bot is searching your lecture now — watch the
                live progress there (Downloading → Uploading). If nothing opened,
                use the link above.
              </p>
            </div>
          )}
        </div>

        {/* ── LECTURE META ──────────────────────────────────────────────── */}
        <div className="w-full rounded-2xl border border-white/10 bg-[#090d24]/85 p-3.5">
          <h2 className="line-clamp-2 text-sm font-extrabold leading-snug text-white">{title}</h2>
          {topic ? (
            <p className="mt-1 line-clamp-2 text-[11px] font-semibold text-cyan-300/90">
              📚 Topic: {topic}
            </p>
          ) : null}
          {courseName ? (
            <p className="mt-0.5 line-clamp-1 text-[11px] font-semibold text-purple-300/90">
              🎓 Course: {courseName}
            </p>
          ) : null}
          {sizeText ? (
            <p className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
              Size: {sizeText}
            </p>
          ) : null}
        </div>

        {/* ── RULES / INFO CHIPS ────────────────────────────────────────── */}
        <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
            <Play className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" />
            <p className="text-[10px] font-semibold leading-snug text-slate-300">
              Daily limit: <span className="text-white">{dailyLimit} videos / 24h</span>
              <br />
              Need more? Contact @{contactUsername}
            </p>
          </div>
          <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
            <p className="text-[10px] font-semibold leading-snug text-slate-300">
              Auto-delete after{" "}
              <span className="text-white">{autoDeleteHours} hour{autoDeleteHours === 1 ? "" : "s"}</span>
              <br />
              Save it before that
            </p>
          </div>
          <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
            <p className="text-[10px] font-semibold leading-snug text-slate-300">
              Smooth playback, no buffering
              <br />
              Extracted By @{creditUsername}
            </p>
          </div>
        </div>

        {/* ── HOW IT WORKS ──────────────────────────────────────────────── */}
        <ol className="w-full space-y-1.5 rounded-2xl border border-white/10 bg-[#090d24]/70 p-3.5">
          {[
            "Tap OPEN IN TELEGRAM above.",
            botUsername
              ? `Telegram opens @${botUsername} with your lecture request.`
              : "Telegram opens the delivery bot with your lecture request.",
            "The bot sends the video with live progress, then deletes it automatically.",
          ].map((step, idx) => (
            <li key={step} className="flex items-start gap-2">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-cyan-500/20 text-[9px] font-black text-cyan-200">
                {idx + 1}
              </span>
              <span className="text-[11px] font-medium leading-snug text-slate-300">{step}</span>
            </li>
          ))}
        </ol>

        {/* ── OPTIONAL FALLBACK (admin ne in-app player allow kiya ho) ──── */}
        {fallbackStreamUrl && onUseFallback ? (
          <div className="w-full pt-1 text-center">
            <button
              type="button"
              onClick={onUseFallback}
              className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 underline-offset-4 transition hover:text-slate-300 hover:underline"
            >
              <Smartphone className="h-3.5 w-3.5" />
              <span>Play in browser instead (may buffer)</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
