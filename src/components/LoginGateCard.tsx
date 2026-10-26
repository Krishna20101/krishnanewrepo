"use client";

import React, { useState } from "react";
import { Eye, EyeOff, Loader2, Lock, Phone, Sparkles } from "lucide-react";
import { useApp } from "@/context/AppContext";
import SafeImage from "@/components/SafeImage";
import { SITE_CONFIG } from "@/config/siteConfig";
// 🔐 Login logic ek alag file me hai: src/lib/login/studentLogin.ts
import { loginStudentRequest } from "@/lib/login/studentLogin";

export default function LoginGateCard() {
  const { markLoggedIn, config } = useApp();
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    // 👉 Login ka poora logic `src/lib/login/studentLogin.ts` me hai.
    const result = await loginStudentRequest(
      { userId, password },
      SITE_CONFIG.apiBaseUrl
    );

    if (!result.ok || !result.sessionToken) {
      setError(result.error || "Login failed. Please try again.");
      setSubmitting(false);
      return;
    }

    markLoggedIn(result.sessionToken);
    setSubmitting(false);
  };

  return (
    <div className="relative z-10 flex min-h-screen items-center justify-center px-4 py-10">
      <div className="glass-card relative w-full max-w-md overflow-hidden rounded-[2rem] border border-cyan-400/25 p-7 sm:p-9 shadow-[0_0_50px_rgba(0,240,255,0.14)]">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-cyan-400 via-purple-500 to-rose-500" />

        <div className="mx-auto mb-5 flex h-24 w-24 items-center justify-center rounded-3xl border border-cyan-400/40 bg-[#0d122d] p-2 shadow-glow-cyan">
          <SafeImage
            src={config.appLogoUrl}
            fallbackSrc={config.defaultImageUrl}
            alt={config.appName}
            className="h-full w-full rounded-2xl object-cover"
          />
        </div>

        <div className="text-center">
          <h1 className="bg-gradient-to-r from-white via-cyan-200 to-purple-300 bg-clip-text text-2xl sm:text-3xl font-black tracking-tight text-transparent">
            {config.appName}
          </h1>
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3.5 py-1 text-[11px] font-extrabold uppercase tracking-widest text-emerald-300">
            <Sparkles className="h-3.5 w-3.5 text-cyan-300" />
            <span>{config.appTagline}</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-7 space-y-4">
          <div className="relative">
            <Phone className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-300/80" />
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="MOBILE NUMBER / USER ID"
              autoComplete="username"
              className="w-full rounded-2xl border border-white/15 bg-[#070a1c]/90 py-3.5 pl-11 pr-4 text-sm font-semibold text-white placeholder-slate-400 outline-none transition focus:border-cyan-400 focus:shadow-glow-cyan"
            />
          </div>

          <div className="relative">
            <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-purple-300/80" />
            <input
              type={showPass ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="PASSWORD"
              autoComplete="current-password"
              className="w-full rounded-2xl border border-white/15 bg-[#070a1c]/90 py-3.5 pl-11 pr-12 text-sm font-semibold text-white placeholder-slate-400 outline-none transition focus:border-purple-400 focus:shadow-glow-purple"
            />
            <button
              type="button"
              onClick={() => setShowPass((s) => !s)}
              aria-label="Toggle password visibility"
              className="absolute right-3.5 top-1/2 -translate-y-1/2 rounded-lg p-1 text-slate-400 transition hover:text-cyan-300"
            >
              {showPass ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>

          {error && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/15 px-3.5 py-2.5 text-center text-xs font-semibold text-rose-200">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-400 via-indigo-500 to-purple-600 py-4 text-sm font-black uppercase tracking-widest text-white shadow-glow-cyan transition duration-200 hover:brightness-110 active:scale-[0.98] disabled:opacity-70"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>PLEASE WAIT, LOGGING IN...</span>
              </>
            ) : (
              <span>LOGIN NOW</span>
            )}
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] font-medium text-slate-400">
          100% Encrypted Session • Instant Access to All Batches
        </p>
      </div>
    </div>
  );
}
