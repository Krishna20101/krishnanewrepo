"use client";

import React from "react";
import { Loader2 } from "lucide-react";

export default function PleaseWaitScreen({
  title = "Please wait, loading...",
  subtitle = "Data taiyar ho raha hai, kripya thoda intezar karein",
  overlay = false,
}: {
  title?: string;
  subtitle?: string;
  overlay?: boolean;
}) {
  if (overlay) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#050611]/80 px-6">
        <div className="w-full max-w-xs rounded-3xl border border-cyan-400/35 bg-[#0b0f29] p-6 text-center shadow-[0_0_40px_rgba(0,240,255,0.2)]">
          <Loader2 className="mx-auto h-9 w-9 animate-spin text-cyan-300" />
          <p className="mt-3 text-sm font-black uppercase tracking-wider text-white">
            {title}
          </p>
          {subtitle && (
            <p className="mt-1 text-xs font-medium text-slate-300">{subtitle}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <div className="rounded-3xl border border-cyan-400/30 bg-[#0b0f29]/95 px-8 py-7 shadow-[0_0_36px_rgba(0,240,255,0.15)]">
        <Loader2 className="mx-auto h-10 w-10 animate-spin text-cyan-300" />
        <p className="mt-3.5 text-sm sm:text-base font-black uppercase tracking-wider text-white">
          {title}
        </p>
        {subtitle && (
          <p className="mt-1 text-xs font-medium text-slate-400">{subtitle}</p>
        )}
      </div>
    </div>
  );
}
