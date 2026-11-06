"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Download,
  LogOut,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import LoginGateCard from "@/components/LoginGateCard";
import SafeImage from "@/components/SafeImage";
import PleaseWaitScreen from "@/components/PleaseWaitScreen";
import { apiUrl } from "@/config/siteConfig";

interface BatchSummaryUI {
  id: string;
  name: string;
  thumbnail: string;
  displayPrice: string;
  important?: boolean;
  totalFolders: number;
  totalVideos: number;
  totalPdfs: number;
}

export default function HomePage() {
  const {
    isHydrated,
    isLoggedIn,
    logoutStudent,
    config,
    studentProfile,
    downloadsList,
    navigateWithWait,
  } = useApp();

  const [batches, setBatches] = useState<BatchSummaryUI[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const activeDownloads = downloadsList.filter(
    (d) => d.status === "downloading"
  ).length;

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

  if (!isHydrated) {
    return <PleaseWaitScreen title="Please wait, loading..." />;
  }

  if (!isLoggedIn) {
    return <LoginGateCard />;
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-6xl">
      {/* ═══════════════ HEADER (flat bar, no glass/neon) ═══════════════ */}
      <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#08090f]/92 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-9 w-9 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-ink-850">
              <SafeImage
                src={config.appLogoUrl}
                fallbackSrc={config.defaultImageUrl}
                alt={config.appName}
                className="h-full w-full object-cover"
              />
            </div>
            <div className="min-w-0">
              <h1 className="truncate font-display text-[17px] font-bold leading-tight tracking-tight text-sand-100">
                {config.appName}
              </h1>
              <p className="truncate text-[11px] font-medium text-sand-400">
                {studentProfile?.name
                  ? `Signed in as ${studentProfile.name}`
                  : config.appTagline}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {/* ⬇ DOWNLOAD — top-right corner box */}
            <button
              type="button"
              onClick={() => navigateWithWait("/downloads", "Opening downloads...")}
              title="Downloads"
              className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] text-sand-200 transition hover:border-ember-500/45 hover:text-ember-300"
            >
              <Download className="h-[17px] w-[17px]" />
              {downloadsList.length > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-ember-500 px-1 text-[9px] font-black text-[#1a0d05]">
                  {activeDownloads > 0 ? "•" : downloadsList.length}
                </span>
              )}
            </button>

            <a
              href={config.telegramJoinUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Telegram"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] text-sand-200 transition hover:border-sage-400/45 hover:text-sage-300"
            >
              <Send className="h-[16px] w-[16px]" />
            </a>

            <button
              type="button"
              onClick={logoutStudent}
              title="Sign out"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] text-sand-300 transition hover:border-rose-400/40 hover:text-rose-300"
            >
              <LogOut className="h-[16px] w-[16px]" />
            </button>
          </div>
        </div>
      </header>

      <main className="px-4 pb-16 pt-7 sm:px-6">
        {/* ═══════════════ HERO + SEARCH (static, no animation) ═══════════ */}
        <section className="mx-auto max-w-2xl">
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-ember-400">
            Your library
          </p>
          <h2 className="mt-2 font-display text-[28px] font-semibold leading-[1.15] tracking-tight text-sand-100 sm:text-[34px]">
            Pick a course and
            <br />
            keep going.
          </h2>
          <p className="mt-2.5 max-w-md text-[13px] leading-relaxed text-sand-400">
            {batches.length > 0
              ? `${batches.length} courses with lectures and notes, all in one place.`
              : "All your lectures and notes, in one place."}
          </p>

          {/* Search — plain field, straight edges, no glow/corners animation */}
          <div className="mt-6">
            <div className="flex items-center gap-2 rounded-xl border border-white/12 bg-ink-850 px-3.5 py-2.5 transition-colors focus-within:border-ember-500/55">
              <Search className="h-4 w-4 shrink-0 text-sand-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search courses by name..."
                aria-label="Search courses"
                className="w-full bg-transparent text-[14px] font-medium text-sand-100 placeholder:text-sand-500 outline-none"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="rounded-md p-0.5 text-sand-400 hover:text-sand-100"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {search && (
              <p className="mt-2 text-[11px] font-medium text-sand-500">
                {filteredBatches.length} result
                {filteredBatches.length === 1 ? "" : "s"} for “{search}”
              </p>
            )}
          </div>
        </section>

        {/* Announcement */}
        {config.announcementEnabled && config.announcementText && (
          <div className="mx-auto mt-6 flex max-w-2xl items-start gap-2.5 rounded-xl border border-ember-500/25 bg-ember-500/[0.08] px-3.5 py-2.5">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember-400" />
            <p className="text-[12px] font-medium leading-relaxed text-ember-300">
              {config.announcementText}
            </p>
          </div>
        )}

        <div className="rule mx-auto mt-8 max-w-2xl" />

        {/* ═══════════════ COURSE GRID ═══════════════ */}
        <section className="mt-6">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-sand-400">
              All courses
            </h3>
            <span className="text-[11px] font-semibold text-sand-500">
              {filteredBatches.length} total
            </span>
          </div>

          {loading ? (
            <PleaseWaitScreen title="Loading courses..." />
          ) : filteredBatches.length === 0 ? (
            <div className="surface rounded-card px-6 py-14 text-center">
              <p className="font-display text-lg font-semibold text-sand-100">
                {search ? "No course matches that search" : "No courses yet"}
              </p>
              <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-sand-400">
                {search
                  ? "Try a shorter keyword, or clear the search to see everything."
                  : "Courses will appear here as soon as they are added."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredBatches.map((batch, index) => (
                <CourseTile
                  key={batch.id}
                  batch={batch}
                  index={index}
                  fallbackImage={config.defaultImageUrl}
                  onOpen={() =>
                    navigateWithWait(
                      `/batch/${encodeURIComponent(batch.id)}`,
                      "Opening course..."
                    )
                  }
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COURSE TILE — naya look: flat surface, hairline frame, corner index number,
// image bleeds to the edge on hover, ember underline sweep on the meta row.
// Koi cyan glow / glass / circular button / gradient pill nahi.
// ═══════════════════════════════════════════════════════════════════════════
function CourseTile({
  batch,
  index,
  fallbackImage,
  onOpen,
}: {
  batch: BatchSummaryUI;
  index: number;
  fallbackImage: string;
  onOpen: () => void;
}) {
  return (
    <article
      className="surface group relative flex flex-col overflow-hidden rounded-card transition-[border-color,transform] duration-200 hover:-translate-y-[3px] hover:border-ember-500/40"
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      {/* thin ember rail on the left, grows on hover */}
      <span className="pointer-events-none absolute inset-y-0 left-0 w-[2px] origin-top scale-y-0 bg-gradient-to-b from-ember-400 to-ember-600 transition-transform duration-300 group-hover:scale-y-100" />

      {/* media */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${batch.name}`}
        className="relative block aspect-[16/9] w-full overflow-hidden bg-ink-850"
      >
        <SafeImage
          src={batch.thumbnail}
          fallbackSrc={fallbackImage}
          alt={batch.name}
          className="h-full w-full object-cover transition-transform duration-[450ms] ease-out group-hover:scale-[1.045]"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950/85 via-ink-950/10 to-transparent" />

        {/* index number — typographic, not a badge */}
        <span className="absolute left-3 top-2.5 font-display text-[26px] font-semibold leading-none text-sand-100/25">
          {String(index + 1).padStart(2, "0")}
        </span>

        {batch.important && (
          <span className="absolute right-3 top-3 rounded-tag border border-ember-400/50 bg-ink-950/85 px-2 py-[3px] text-[9px] font-extrabold uppercase tracking-[0.14em] text-ember-300">
            Featured
          </span>
        )}
      </button>

      {/* body */}
      <div className="flex flex-1 flex-col px-4 pb-4 pt-3.5">
        <h4 className="line-clamp-2 font-display text-[16px] font-semibold leading-snug text-sand-100 transition-colors group-hover:text-ember-300">
          {batch.name}
        </h4>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-sand-500">
          {batch.totalFolders > 0 && (
            <span>
              {batch.totalFolders} subject{batch.totalFolders === 1 ? "" : "s"}
            </span>
          )}
          {batch.totalVideos > 0 && (
            <span className="text-sand-400">
              {batch.totalVideos} lecture{batch.totalVideos === 1 ? "" : "s"}
            </span>
          )}
          {batch.totalPdfs > 0 && (
            <span className="text-sage-400">
              {batch.totalPdfs} note{batch.totalPdfs === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {/* meta row + open affordance */}
        <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-3">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-sand-500">
            {batch.displayPrice === "FREE" ? "Free access" : batch.displayPrice}
          </span>
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1.5 text-[12px] font-bold text-ember-400 transition-colors hover:text-ember-300"
          >
            Open
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </article>
  );
}
