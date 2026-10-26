"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Heart, Play, Sparkles, Star } from "lucide-react";
import { useApp } from "@/context/AppContext";
import GlowingBackButton from "@/components/GlowingBackButton";
import BottomDock from "@/components/BottomDock";
import SafeImage from "@/components/SafeImage";
import LoginGateCard from "@/components/LoginGateCard";
import PleaseWaitScreen from "@/components/PleaseWaitScreen";
import { BatchSummaryUI } from "@/components/BatchCard";
import { apiUrl } from "@/config/siteConfig";

export default function WishlistPage() {
  const {
    isHydrated,
    isLoggedIn,
    wishlistIds,
    toggleWishlist,
    config,
    navigateWithWait,
  } = useApp();
  const [batches, setBatches] = useState<BatchSummaryUI[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLoggedIn) return;
    setLoading(true);
    fetch(apiUrl("/api/batches"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok && Array.isArray(d.batches)) {
          setBatches(d.batches);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isLoggedIn]);

  const savedBatches = useMemo(
    () => batches.filter((b) => wishlistIds.includes(String(b.id))),
    [batches, wishlistIds]
  );

  if (!isHydrated) {
    return <PleaseWaitScreen title="Please wait, loading..." />;
  }
  if (!isLoggedIn) return <LoginGateCard />;

  return (
    <div className="mx-auto min-h-screen max-w-5xl pb-28">
      <header className="sticky top-0 z-30 flex items-center gap-4 border-b border-white/10 bg-[#07091b]/95 px-4 py-3.5 backdrop-blur-md">
        <GlowingBackButton fallbackHref="/" />
        <div className="flex items-center gap-2">
          <Heart className="h-5 w-5 fill-rose-500 text-rose-400" />
          <h1 className="text-lg sm:text-xl font-black uppercase tracking-wider text-white">
            WISHLIST
          </h1>
        </div>
      </header>

      <main className="px-4 pt-6">
        {loading ? (
          <PleaseWaitScreen
            title="Please wait, loading wishlist..."
            subtitle="Saved batches load ho rahe hain..."
          />
        ) : savedBatches.length === 0 ? (
          <div className="glass-card mx-auto my-12 max-w-md rounded-3xl border border-rose-400/25 p-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-rose-400/40 bg-rose-500/15">
              <Heart className="h-8 w-8 text-rose-400" />
            </div>
            <h2 className="text-xl font-black text-white">
              Wishlist Abhi Khali Hai
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Home page par kisi bhi batch ke upar ❤️ heart icon dabayein taki
              apne favourite batches yahan quick-open kar sakein!
            </p>
            <Link
              href="/"
              className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-rose-500 via-pink-500 to-purple-600 px-6 py-3 text-xs font-black uppercase tracking-widest text-white transition hover:brightness-110"
            >
              <Sparkles className="h-4 w-4" />
              <span>Explore Batches</span>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {savedBatches.map((batch) => (
              <div
                key={batch.id}
                className="glass-card glass-card-hover flex flex-col overflow-hidden rounded-3xl border border-white/10 p-3"
              >
                <div className="relative aspect-[16/9] w-full overflow-hidden rounded-2xl bg-[#0b0f26]">
                  <SafeImage
                    src={batch.thumbnail}
                    fallbackSrc={config.defaultImageUrl}
                    alt={batch.name}
                    className="h-full w-full object-cover"
                  />
                  <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
                    <span className="rounded-full border border-amber-400/40 bg-black/80 px-2.5 py-0.5 text-[11px] font-black text-amber-300">
                      {batch.displayPrice}
                    </span>
                    {batch.important && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-black text-slate-950">
                        <Star className="h-2.5 w-2.5 fill-slate-950" />
                        TOP
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleWishlist(batch.id)}
                    aria-label="Remove from wishlist"
                    className="absolute right-2.5 top-2.5 flex h-9 w-9 items-center justify-center rounded-full border border-rose-400/70 bg-rose-500/30 text-rose-400"
                  >
                    <Heart className="h-4 w-4 fill-rose-500 text-rose-400" />
                  </button>
                </div>

                <h3 className="mt-3 line-clamp-2 flex-1 px-1 text-base font-extrabold text-white">
                  {batch.name}
                </h3>

                <button
                  type="button"
                  onClick={() =>
                    navigateWithWait(
                      `/batch/${encodeURIComponent(batch.id)}`,
                      "Please wait, opening course..."
                    )
                  }
                  className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-2xl border border-indigo-400/50 bg-gradient-to-r from-indigo-600/35 to-purple-600/35 py-2.5 text-xs font-black uppercase tracking-widest text-white transition hover:brightness-115 active:scale-95"
                >
                  <Play className="h-3.5 w-3.5 fill-cyan-300 text-cyan-300" />
                  <span>OPEN</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      <BottomDock />
    </div>
  );
}
