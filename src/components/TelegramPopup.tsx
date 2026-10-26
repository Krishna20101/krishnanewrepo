"use client";

import React, { useEffect, useState } from "react";
import { Send, Sparkles, X } from "lucide-react";
import { useApp } from "@/context/AppContext";

/**
 * Telegram Daily Upload Join Popup
 * - Opens automatically when transitioning from Login -> Batch Home
 * - Top-right corner 'X' button to dismiss manually
 * - Automatic 5-second countdown timer that auto-closes if user doesn't click X
 * - Glowing 'JOIN NOW' button pointing to editable Telegram placeholder URL
 */
export default function TelegramPopup() {
  const { showTelegramPopup, closeTelegramPopup, config } = useApp();
  const totalMs = (config.telegramAutoCloseSeconds || 5) * 1000;
  const [remainingMs, setRemainingMs] = useState(totalMs);

  useEffect(() => {
    if (!showTelegramPopup) return;
    setRemainingMs(totalMs);

    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const left = Math.max(0, totalMs - elapsed);
      setRemainingMs(left);
      if (left <= 0) {
        clearInterval(interval);
        closeTelegramPopup();
      }
    }, 50);

    return () => clearInterval(interval);
  }, [showTelegramPopup, totalMs, closeTelegramPopup]);

  if (!showTelegramPopup) return null;

  const secondsLeft = Math.ceil(remainingMs / 1000);
  const progressPct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-md animate-in fade-in duration-200"
      onClick={closeTelegramPopup}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-cyan-400/40 bg-gradient-to-b from-[#11173b] via-[#0c1029] to-[#080b1d] p-6 shadow-[0_0_50px_rgba(0,240,255,0.28)]"
      >
        {/* Top Corner X Button + Live Countdown */}
        <button
          type="button"
          onClick={closeTelegramPopup}
          aria-label="Close Telegram Popup"
          className="absolute right-3.5 top-3.5 flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2.5 py-1.5 text-xs font-bold text-slate-200 transition hover:border-rose-400/60 hover:bg-rose-500/20 hover:text-white"
        >
          <span className="text-[11px] font-semibold text-cyan-300">
            {secondsLeft}s
          </span>
          <X className="h-4 w-4" />
        </button>

        {/* Glowing Telegram Icon */}
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-400/40 bg-gradient-to-br from-cyan-500/25 to-blue-600/25 shadow-glow-cyan">
          <Send className="h-8 w-8 -translate-x-0.5 translate-y-0.5 text-cyan-300" />
        </div>

        {/* Badge */}
        <div className="mx-auto mb-2 inline-flex w-full justify-center">
          <span className="inline-flex items-center gap-1 rounded-full border border-purple-400/35 bg-purple-500/15 px-3 py-0.5 text-[11px] font-bold uppercase tracking-wider text-purple-200">
            <Sparkles className="h-3 w-3 text-cyan-300" />
            Daily Batch Uploads
          </span>
        </div>

        <h3 className="text-center text-xl font-extrabold tracking-tight text-white">
          {config.telegramPopupTitle}
        </h3>
        <p className="mt-2 text-center text-sm leading-relaxed text-slate-300">
          {config.telegramPopupSubtitle}
        </p>

        {/* Glowing JOIN NOW CTA */}
        <a
          href={config.telegramJoinUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={closeTelegramPopup}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-400 via-sky-500 to-violet-600 px-5 py-3.5 text-sm font-black uppercase tracking-wider text-slate-950 shadow-glow-cyan transition duration-200 hover:scale-[1.02] hover:brightness-110 active:scale-95"
        >
          <Send className="h-4 w-4 fill-slate-950" />
          <span>JOIN NOW</span>
        </a>

        <p className="mt-3 text-center text-[11px] text-slate-400">
          Auto-closing in {secondsLeft} sec • Tap ✕ anytime
        </p>

        {/* Bottom Shrinking Timer Bar */}
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
          <div
            className="h-full bg-gradient-to-r from-cyan-400 via-purple-400 to-pink-500 transition-all duration-75 ease-linear"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
