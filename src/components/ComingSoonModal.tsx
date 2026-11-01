"use client";

import React from "react";
import { FileText, Rocket, Sparkles, X } from "lucide-react";
import { useApp } from "@/context/AppContext";

/**
 * Global Popup Modal whenever a user clicks ANY PDF button/item.
 */
export default function ComingSoonModal() {
  const { pdfModalTitle, closePdfComingSoon } = useApp();

  if (!pdfModalTitle) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
      onClick={closePdfComingSoon}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-rose-400/40 bg-gradient-to-b from-[#1a1130] via-[#100d24] to-[#080919] p-6 text-center shadow-glow-pink"
      >
        <button
          type="button"
          onClick={closePdfComingSoon}
          aria-label="Close"
          className="absolute right-3.5 top-3.5 rounded-full border border-white/15 bg-white/10 p-1.5 text-slate-300 transition hover:border-rose-400/60 hover:bg-rose-500/20 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-rose-400/40 bg-gradient-to-br from-rose-500/25 to-purple-600/25 shadow-glow-pink">
          <FileText className="h-8 w-8 text-rose-300" />
        </div>

        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/35 bg-amber-500/15 px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-amber-300">
          <Sparkles className="h-3.5 w-3.5" />
          In Progress
        </span>

        <h3 className="mt-3 text-2xl font-black tracking-tight text-white">
          Coming Soon!
        </h3>

        <p className="mt-1.5 line-clamp-2 text-xs font-semibold text-rose-300/90">
          {pdfModalTitle}
        </p>

        <p className="mt-2.5 text-sm leading-relaxed text-slate-300">
          PDF Reader & High-Speed Notes Viewer abhi upgrade ho raha hai. Bahut
          jald yahan saare PDF notes direct open honge!
        </p>

        <button
          type="button"
          onClick={closePdfComingSoon}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-rose-500 via-pink-500 to-purple-600 px-5 py-3 text-sm font-extrabold uppercase tracking-wider text-white shadow-glow-pink transition hover:brightness-110 active:scale-95"
        >
          <Rocket className="h-4 w-4" />
          <span>Got It</span>
        </button>
      </div>
    </div>
  );
}
