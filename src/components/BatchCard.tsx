"use client";

import React from "react";
import { ArrowRight, Heart, Star } from "lucide-react";
import SafeImage from "@/components/SafeImage";
import { useApp } from "@/context/AppContext";

export interface BatchSummaryUI {
  id: string;
  name: string;
  thumbnail: string;
  displayPrice: string;
  important?: boolean;
  totalFolders: number;
  totalVideos: number;
  totalPdfs: number;
}

export default function BatchCard({ batch }: { batch: BatchSummaryUI }) {
  const { isWishlisted, toggleWishlist, config, navigateWithWait } = useApp();
  const liked = isWishlisted(batch.id);

  return (
    <div
      className={`glass-card glass-card-hover perf-card-item group relative flex flex-col overflow-hidden rounded-3xl border p-3 ${
        batch.important
          ? "border-amber-400/55 shadow-[0_0_28px_rgba(251,191,36,0.16)]"
          : "border-white/10"
      }`}
    >
      {/* Thumbnail Banner Container */}
      <div className="relative aspect-[16/9] w-full overflow-hidden rounded-2xl bg-[#0b0f26]">
        <SafeImage
          src={batch.thumbnail}
          fallbackSrc={config.defaultImageUrl}
          alt={batch.name}
          className="h-full w-full object-cover"
        />

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#070a1c]/80 via-transparent to-black/25" />

        {/* Top-Left Corner Price + ⭐ IMPORTANT Badges */}
        <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
          <div className="rounded-full border border-amber-400/50 bg-[#171308]/90 px-3 py-1 text-xs font-black tracking-wide text-amber-300">
            {batch.displayPrice}
          </div>
          {batch.important && (
            <div className="inline-flex items-center gap-1 rounded-full border border-amber-300/80 bg-gradient-to-r from-amber-500 to-orange-500 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-slate-950 shadow-[0_0_16px_rgba(251,191,36,0.6)]">
              <Star className="h-3 w-3 fill-slate-950 text-slate-950" />
              <span>IMPORTANT</span>
            </div>
          )}
        </div>

        {/* Top-Right Wishlist Heart Button */}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleWishlist(batch.id);
          }}
          aria-label="Toggle Wishlist"
          className={`absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full border transition-all duration-200 active:scale-90 ${
            liked
              ? "border-rose-400/70 bg-rose-500/30 text-rose-400"
              : "border-white/20 bg-black/65 text-white/85 hover:border-rose-400/50 hover:text-rose-300"
          }`}
        >
          <Heart
            className={`h-5 w-5 ${liked ? "fill-rose-500 text-rose-400" : ""}`}
          />
        </button>
      </div>

      {/* Card Body */}
      <div className="mt-3.5 flex flex-1 flex-col px-1.5 pb-1">
        <div className="flex items-center justify-between">
          <div className="inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-wider text-orange-400">
            <span className="h-2 w-2 rounded-full bg-orange-400" />
            <span>LIFE TIME</span>
          </div>
          <span className="bg-gradient-to-r from-cyan-300 via-emerald-300 to-cyan-200 bg-clip-text text-sm font-black italic tracking-wider text-transparent">
            FREE
          </span>
        </div>

        <h2 className="mt-2 line-clamp-2 text-lg font-extrabold leading-snug text-white group-hover:text-cyan-200 transition-colors">
          {batch.name}
        </h2>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-slate-400">
          {batch.totalVideos > 0 && (
            <span className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-cyan-300">
              {batch.totalVideos} Lectures
            </span>
          )}
          {batch.totalPdfs > 0 && (
            <span className="rounded-lg border border-purple-500/20 bg-purple-500/10 px-2 py-0.5 text-purple-300">
              {batch.totalPdfs} Notes
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() =>
            navigateWithWait(
              `/batch/${encodeURIComponent(batch.id)}`,
              "Please wait, opening course..."
            )
          }
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-cyan-400/35 bg-gradient-to-r from-cyan-500/20 via-indigo-500/25 to-purple-600/25 py-3.5 text-xs font-black uppercase tracking-[0.18em] text-white transition-all duration-200 hover:border-cyan-300 hover:from-cyan-500/35 hover:to-purple-600/40 active:scale-[0.98]"
        >
          <span>OPEN BATCH</span>
          <ArrowRight className="h-4 w-4 text-cyan-300" />
        </button>
      </div>
    </div>
  );
}
