"use client";

import React from "react";
import { Clock, Sparkles } from "lucide-react";

interface ComingSoonStateProps {
  title: string;
  subtitle: string;
  badge?: string;
  accent?: "cyan" | "purple" | "pink";
}

/**
 * Reusable sleek GenZ "In Progress • Coming Soon" card
 * Used in Downloads (Video & PDF), Test Tab, and Live Classes Tab.
 */
export default function ComingSoonState({
  title,
  subtitle,
  badge = "IN PROGRESS • COMING SOON",
  accent = "purple",
}: ComingSoonStateProps) {
  const accentStyles = {
    cyan: {
      border: "border-cyan-400/30",
      glow: "shadow-glow-cyan",
      iconBg: "from-cyan-500/25 to-blue-600/20 border-cyan-400/40 text-cyan-300",
      pill: "border-cyan-400/40 bg-cyan-500/15 text-cyan-200",
    },
    purple: {
      border: "border-purple-400/30",
      glow: "shadow-glow-purple",
      iconBg:
        "from-purple-500/25 to-indigo-600/20 border-purple-400/40 text-purple-300",
      pill: "border-purple-400/40 bg-purple-500/15 text-purple-200",
    },
    pink: {
      border: "border-rose-400/30",
      glow: "shadow-glow-pink",
      iconBg: "from-rose-500/25 to-pink-600/20 border-rose-400/40 text-rose-300",
      pill: "border-rose-400/40 bg-rose-500/15 text-rose-200",
    },
  }[accent];

  return (
    <div
      className={`glass-card mx-auto my-8 flex max-w-md flex-col items-center rounded-3xl border p-8 text-center ${accentStyles.border} ${accentStyles.glow}`}
    >
      <div
        className={`mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border bg-gradient-to-br ${accentStyles.iconBg}`}
      >
        <Clock className="h-8 w-8 animate-pulse" />
      </div>

      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1 text-[11px] font-extrabold uppercase tracking-widest ${accentStyles.pill}`}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {badge}
      </span>

      <h3 className="mt-4 bg-gradient-to-r from-white via-cyan-100 to-purple-200 bg-clip-text text-2xl font-black tracking-tight text-transparent">
        {title}
      </h3>

      <p className="mt-2 text-sm leading-relaxed text-slate-300">{subtitle}</p>

      {/* Animated Progress Indicator */}
      <div className="mt-6 w-full max-w-[220px]">
        <div className="mb-1.5 flex justify-between text-[11px] font-bold text-slate-400">
          <span>Feature Build</span>
          <span className="text-cyan-300">In Progress...</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-white/10 p-0.5">
          <div className="h-full w-3/4 rounded-full bg-gradient-to-r from-cyan-400 via-purple-500 to-pink-500 animate-pulse" />
        </div>
      </div>
    </div>
  );
}
