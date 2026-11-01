"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AudioWaveform,
  LogOut,
  Megaphone,
  Search,
  Send,
  X,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import LoginGateCard from "@/components/LoginGateCard";
import BatchCard, { BatchSummaryUI } from "@/components/BatchCard";
import BottomDock from "@/components/BottomDock";
import SafeImage from "@/components/SafeImage";
import PleaseWaitScreen from "@/components/PleaseWaitScreen";
import { apiUrl } from "@/config/siteConfig";

export default function HomePage() {
  const { isHydrated, isLoggedIn, logoutStudent, config } = useApp();
  const [batches, setBatches] = useState<BatchSummaryUI[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(12);

  useEffect(() => {
    if (!isLoggedIn) return;
    let active = true;
    setLoading(true);
    fetch(apiUrl("/api/batches"), { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (active && data?.ok && Array.isArray(data.batches)) {
          setBatches(data.batches);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isLoggedIn]);

  const filteredBatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return batches;
    return batches.filter((b) => b.name.toLowerCase().includes(q));
  }, [batches, search]);

  const visibleBatches = useMemo(
    () => filteredBatches.slice(0, visibleCount),
    [filteredBatches, visibleCount]
  );

  if (!isHydrated) {
    return (
      <PleaseWaitScreen
        title="Please wait, loading..."
        subtitle="Study helper Doc start ho raha hai..."
      />
    );
  }

  if (!isLoggedIn) {
    return <LoginGateCard />;
  }

  return (
    <div className="mx-auto min-h-screen max-w-5xl pb-28">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#07091b]/95 px-4 py-3.5 backdrop-blur-md">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 overflow-hidden rounded-xl border border-cyan-400/40 bg-[#0f1433] p-0.5 shadow-glow-cyan">
              <SafeImage
                src={config.appLogoUrl}
                fallbackSrc={config.defaultImageUrl}
                alt={config.appName}
                className="h-full w-full rounded-[10px] object-cover"
              />
            </div>
            <div>
              <h1 className="bg-gradient-to-r from-cyan-300 via-indigo-300 to-purple-300 bg-clip-text text-lg sm:text-xl font-black uppercase tracking-wider text-transparent">
                {config.appName}
              </h1>
              <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-300/90">
                All Batches Unlocked
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              href={config.telegramJoinUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Join Telegram"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-400/35 bg-cyan-500/10 text-cyan-300 transition hover:border-cyan-300 hover:bg-cyan-500/20"
            >
              <Send className="h-4 w-4" />
            </a>
            <button
              type="button"
              onClick={logoutStudent}
              title="Logout"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-slate-300 transition hover:border-rose-400/50 hover:bg-rose-500/15 hover:text-rose-200"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="px-4 pt-5">
        {config.announcementEnabled && config.announcementText && (
          <div className="mx-auto mb-5 flex max-w-2xl items-center gap-3 rounded-2xl border border-cyan-400/35 bg-gradient-to-r from-cyan-500/15 via-indigo-500/15 to-purple-500/15 px-4 py-3 text-xs font-bold text-cyan-100">
            <Megaphone className="h-4 w-4 shrink-0 text-cyan-300" />
            <p className="leading-snug">{config.announcementText}</p>
          </div>
        )}

        {/* Search Box */}
        <div className="relative mx-auto mb-6 max-w-2xl">
          <span className="pointer-events-none absolute -left-1 -top-1 h-3.5 w-3.5 rounded-tl-lg border-l-2 border-t-2 border-purple-400" />
          <span className="pointer-events-none absolute -right-1 -top-1 h-3.5 w-3.5 rounded-tr-lg border-r-2 border-t-2 border-cyan-400" />
          <span className="pointer-events-none absolute -bottom-1 -left-1 h-3.5 w-3.5 rounded-bl-lg border-b-2 border-l-2 border-cyan-400" />
          <span className="pointer-events-none absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-br-lg border-b-2 border-r-2 border-purple-400" />

          <div className="glass-card flex items-center rounded-2xl border border-white/15 px-4 py-3 focus-within:border-cyan-400/60">
            <Search className="h-5 w-5 text-emerald-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setVisibleCount(12);
              }}
              placeholder="SEARCH BATCH..."
              className="w-full bg-transparent px-3.5 text-sm font-bold tracking-wider text-white placeholder-slate-400 outline-none"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="rounded-lg p-1 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            ) : (
              <AudioWaveform className="h-5 w-5 text-emerald-400/80" />
            )}
          </div>
        </div>

        {loading ? (
          <PleaseWaitScreen
            title="Please wait, loading courses..."
            subtitle="Sabhi batches load ho rahe hain..."
          />
        ) : filteredBatches.length === 0 ? (
          <div className="glass-card mx-auto my-12 max-w-md rounded-3xl border border-white/10 p-8 text-center">
            <p className="text-lg font-extrabold text-white">
              Koi matching batch nahi mila
            </p>
            <p className="mt-1.5 text-sm text-slate-400">
              Search keyword change karein ya sabhi batches dekhne ke liye clear
              karein.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {visibleBatches.map((batch) => (
                <BatchCard key={batch.id} batch={batch} />
              ))}
            </div>

            {filteredBatches.length > visibleCount && (
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={() => setVisibleCount((c) => c + 12)}
                  className="rounded-2xl border border-cyan-400/40 bg-cyan-500/15 px-6 py-3 text-xs font-black uppercase tracking-widest text-cyan-200 hover:bg-cyan-500/25"
                >
                  Load More Courses ({filteredBatches.length - visibleCount}{" "}
                  remaining)
                </button>
              </div>
            )}
          </>
        )}
      </main>

      <BottomDock />
    </div>
  );
}
