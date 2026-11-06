"use client";

import React, { useState } from "react";
import { ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
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
  const [notice, setNotice] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setSubmitting(true);

    const result = await loginStudentRequest(
      { userId, password },
      SITE_CONFIG.apiBaseUrl
    );

    if (!result.ok) {
      setError(result.error || "Login failed. Please try again.");
      setSubmitting(false);
      return;
    }

    if (result.isNewAccount) {
      setNotice("Account created — welcome aboard.");
    }

    markLoggedIn();
    setSubmitting(false);
  };

  return (
    <div className="relative z-10 flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        {/* Brand row above the card (flat, no neon halo) */}
        <div className="mb-6 flex items-center gap-3 px-1">
          <div className="h-11 w-11 overflow-hidden rounded-xl border border-white/12 bg-ink-850">
            <SafeImage
              src={config.appLogoUrl}
              fallbackSrc={config.defaultImageUrl}
              alt={config.appName}
              className="h-full w-full object-cover"
            />
          </div>
          <div className="min-w-0">
            <p className="truncate font-display text-[17px] font-semibold leading-tight text-sand-100">
              {config.appName}
            </p>
            <p className="text-[11px] font-medium text-sand-400">
              {config.appTagline}
            </p>
          </div>
        </div>

        <div className="surface-raised rounded-card overflow-hidden">
          {/* top hairline accent */}
          <div className="h-[2px] w-full bg-gradient-to-r from-ember-600 via-ember-400 to-transparent" />

          <div className="px-6 pb-6 pt-6 sm:px-7">
            <h1 className="font-display text-[22px] font-semibold leading-tight tracking-tight text-sand-100">
              Sign in
            </h1>
            <p className="mt-1 text-[12.5px] leading-relaxed text-sand-400">
              Enter any email / mobile number / user ID and a password. First
              time here? Your account is created automatically.
            </p>

            <form onSubmit={handleSubmit} className="mt-6 space-y-3">
              <div>
                <label
                  htmlFor="login-id"
                  className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.14em] text-sand-400"
                >
                  Email / Mobile / User ID
                </label>
                <input
                  id="login-id"
                  type="text"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="username"
                  className="w-full rounded-xl border border-white/12 bg-ink-950/70 px-3.5 py-3 text-[14px] font-medium text-sand-100 placeholder:text-sand-500 outline-none transition-colors focus:border-ember-500/60"
                />
              </div>

              <div>
                <label
                  htmlFor="login-pass"
                  className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.14em] text-sand-400"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="login-pass"
                    type={showPass ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    className="w-full rounded-xl border border-white/12 bg-ink-950/70 px-3.5 py-3 pr-11 text-[14px] font-medium text-sand-100 placeholder:text-sand-500 outline-none transition-colors focus:border-ember-500/60"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((s) => !s)}
                    aria-label={showPass ? "Hide password" : "Show password"}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-sand-400 transition-colors hover:text-sand-100"
                  >
                    {showPass ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              {notice && (
                <p className="rounded-lg border border-sage-400/30 bg-sage-400/10 px-3 py-2 text-[12px] font-semibold text-sage-300">
                  {notice}
                </p>
              )}

              {error && (
                <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[12px] font-semibold leading-relaxed text-rose-300">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="btn-ember mt-1 w-full py-3.5 text-[13px] uppercase tracking-[0.14em] disabled:opacity-70"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Signing in</span>
                  </>
                ) : (
                  <>
                    <span>Continue</span>
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </form>

            <div className="mt-5 border-t border-white/[0.07] pt-4">
              <p className="text-[11px] leading-relaxed text-sand-500">
                No registration form needed — the first sign-in creates your
                account. Use the same ID and password next time.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
