"use client";

// ============================================================================
// 🎬 SMART VIDEO PLAYER — "Jhal-Jhal / Frame-Jump" Khatam Karne Wala Engine
// ============================================================================
// Ye player 4 problems ko ek saath solve karta hai:
//
//  1) OFFLINE-FIRST PLAYBACK
//     Agar lecture phone ke andar (IndexedDB Vault) save hai to video seedha
//     vault se chalti hai — 0% internet, 0% server load, bilkul asli file
//     jaisa smooth (upar "OFFLINE" green badge dikhta hai).
//
//  2) GAP-JUMP CONTROLLER  ← asli anti-jhal-jhal fix
//     Agar network/stream ki wajah se buffer me chhed (hole) reh jata hai, to
//     Chrome ka decoder frames ko aage-piche phenkta hai (video ke andar ka
//     character hilta/kapta dikhta hai). Ye controller har 350ms buffer check
//     karta hai aur playback ko hole ke paar agle buffered frame par le jata
//     hai — jaise hls.js / video.js karte hain. Natija: smooth linear playback.
//
//  3) STALL WATCHDOG + SOURCE FAILOVER
//     3 second tak progress nahi hua -> halka sa nudge (0.1s)
//     6 second tak progress nahi hua -> range request dubara (video.load())
//     Network error -> Cloudflare Edge URL se seedha Vercel API URL par shift
//     (dono fail -> saaf error message + Retry button)
//
//  4) RESUME + ENGINE DIAGNOSTICS
//     Video chhodne par position save, wapas aane par wahin se start.
//     HEAD request se pata karta hai ki stream BOT se aa raha hai ya USER
//     session se, aur Edge Cache HIT hua ya MISS (Admin ke liye best debug).
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, WifiOff, Zap } from "lucide-react";

export type PlayerStreamMode = "offline" | "edge" | "direct";

export interface SmartVideoPlayerProps {
  /** Cloudflare Worker URL (agar admin ne set kiya) ya direct API URL */
  primarySrc: string;
  /** Direct Vercel API URL (worker fail hone par automatic failover) */
  fallbackSrc?: string;
  /** IndexedDB Vault blob URL — video offline chalegi */
  offlineSrc?: string | null;
  poster?: string;
  title?: string;
  /** localStorage key jisme last position save hogi */
  resumeKey: string;
  videoRef?: React.MutableRefObject<HTMLVideoElement | null>;
  className?: string;
  onModeChange?: (mode: PlayerStreamMode, info: string) => void;
  onError?: (message: string) => void;
}

const GAP_CHECK_MS = 350;
const STALL_NUDGE_MS = 3000;
const STALL_RELOAD_MS = 6500;
const RESUME_SAVE_MS = 5000;

function bufferedAhead(video: HTMLVideoElement): number {
  try {
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= t && video.buffered.end(i) >= t) {
        return video.buffered.end(i) - t;
      }
    }
  } catch {
    // ignore
  }
  return 0;
}

/** currentTime kis buffered range me hai? Na ho to agla range start (gap detect) */
function findGapTarget(video: HTMLVideoElement): number | null {
  try {
    const t = video.currentTime;
    const n = video.buffered.length;
    if (n === 0) return null;

    for (let i = 0; i < n; i++) {
      const s = video.buffered.start(i);
      const e = video.buffered.end(i);
      // 0.35s ki tolerance: range ke andar hi hai to koi gap nahi
      if (t >= s - 0.35 && t <= e) return null;
    }

    // Sabse nazdeek ka buffered start dhundo (max 10s aage)
    let best: number | null = null;
    for (let i = 0; i < n; i++) {
      const s = video.buffered.start(i);
      if (s > t && s - t <= 10) {
        if (best === null || s < best) best = s;
      }
    }
    return best === null ? null : best + 0.05;
  } catch {
    return null;
  }
}

export default function SmartVideoPlayer({
  primarySrc,
  fallbackSrc,
  offlineSrc,
  poster,
  title = "Lecture",
  resumeKey,
  videoRef,
  className = "",
  onModeChange,
  onError,
}: SmartVideoPlayerProps) {
  const internalRef = useRef<HTMLVideoElement | null>(null);
  const video = videoRef || internalRef;

  const [mode, setMode] = useState<PlayerStreamMode>(
    offlineSrc ? "offline" : primarySrc.includes("workers.dev") ? "edge" : "direct"
  );
  const [engineInfo, setEngineInfo] = useState("");
  const [buffering, setBuffering] = useState(false);
  const [fatalError, setFatalError] = useState("");
  const [bufferAhead, setBufferAhead] = useState(0);
  const [gapJumps, setGapJumps] = useState(0);
  const [resumedLabel, setResumedLabel] = useState("");

  const lastProgressAt = useRef<number>(Date.now());
  const lastTime = useRef<number>(0);
  const reloadCount = useRef<number>(0);
  const modeRef = useRef<PlayerStreamMode>(mode);

  const currentSrc = useCallback((): string => {
    if (modeRef.current === "offline" && offlineSrc) return offlineSrc;
    if (modeRef.current === "edge") return primarySrc;
    return fallbackSrc || primarySrc;
  }, [offlineSrc, primarySrc, fallbackSrc]);

  const applyMode = useCallback(
    (next: PlayerStreamMode, info = "") => {
      modeRef.current = next;
      setMode(next);
      setEngineInfo(info);
      onModeChange?.(next, info);
    },
    [onModeChange]
  );

  // ---------------------------------------------------------------- source set
  useEffect(() => {
    const el = video.current;
    if (!el) return;

    const initialMode: PlayerStreamMode = offlineSrc
      ? "offline"
      : primarySrc.includes("workers.dev") ||
        (!primarySrc.startsWith("/") && !fallbackSrc)
      ? "edge"
      : fallbackSrc
      ? "edge"
      : "direct";

    applyMode(initialMode);
    el.src = currentSrc();
    el.load();
    setFatalError("");
    reloadCount.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primarySrc, fallbackSrc, offlineSrc]);

  // ------------------------------------------------- engine diagnostics (HEAD)
  useEffect(() => {
    if (modeRef.current === "offline") {
      setEngineInfo("IndexedDB Vault");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(currentSrc(), {
          method: "HEAD",
          headers: { "X-SHD-Client": "web-player" },
          cache: "no-store",
        });
        if (cancelled) return;
        const engine = res.headers.get("X-SHD-Engine") || "";
        const edge = res.headers.get("X-SHD-Edge-Cache") || "";
        const size = res.headers.get("X-SHD-Total-Size") || "";
        const bits: string[] = [];
        if (engine === "telegram-bot") bits.push("BOT STREAM");
        else if (engine === "telegram-user") bits.push("USER SESSION");
        if (edge) bits.push(`EDGE ${edge}`);
        if (size) bits.push(`${Math.round(Number(size) / 1048576)} MB`);
        setEngineInfo(bits.join(" • "));
      } catch {
        // ignore (CORS/HEAD blocked)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [primarySrc, fallbackSrc, offlineSrc, currentSrc]);

  // ------------------------------------------------------- resume last position
  useEffect(() => {
    const el = video.current;
    if (!el) return;

    const onMeta = () => {
      try {
        const raw = localStorage.getItem(`shd_resume_${resumeKey}`);
        const saved = raw ? Number(raw) : 0;
        const dur = el.duration || 0;
        if (saved > 15 && dur > 0 && saved < dur - 25) {
          el.currentTime = saved;
          const mm = Math.floor(saved / 60);
          const ss = Math.floor(saved % 60);
          setResumedLabel(`Resumed from ${mm}:${ss.toString().padStart(2, "0")}`);
          setTimeout(() => setResumedLabel(""), 3500);
        }
      } catch {
        // ignore
      }
    };

    el.addEventListener("loadedmetadata", onMeta);
    return () => el.removeEventListener("loadedmetadata", onMeta);
  }, [resumeKey, video]);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const t = setInterval(() => {
      try {
        if (el.currentTime > 5 && !el.paused) {
          localStorage.setItem(
            `shd_resume_${resumeKey}`,
            String(Math.floor(el.currentTime))
          );
        }
      } catch {
        // ignore
      }
    }, RESUME_SAVE_MS);
    return () => clearInterval(t);
  }, [resumeKey, video]);

  // ------------------------------------------------- GAP JUMP + STALL WATCHDOG
  useEffect(() => {
    const el = video.current;
    if (!el) return;

    const timer = setInterval(() => {
      try {
        if (el.paused || el.ended || modeRef.current === "offline") {
          lastProgressAt.current = Date.now();
          return;
        }

        setBufferAhead(Math.round(bufferedAhead(el)));

        // 1) Progress ho raha hai? -> sab theek
        if (el.currentTime !== lastTime.current) {
          lastTime.current = el.currentTime;
          lastProgressAt.current = Date.now();
          setBuffering(false);
          return;
        }

        // 2) Buffer me hole hai? -> uske paar jump karo (anti jhal-jhal)
        const gapTarget = findGapTarget(el);
        if (gapTarget !== null && Number.isFinite(gapTarget)) {
          el.currentTime = gapTarget;
          lastProgressAt.current = Date.now();
          setGapJumps((g) => g + 1);
          return;
        }

        const stuckFor = Date.now() - lastProgressAt.current;

        // 3) 3s stuck -> halka nudge
        if (stuckFor > STALL_NUDGE_MS && stuckFor < STALL_RELOAD_MS) {
          setBuffering(true);
          try {
            el.currentTime = Math.min(
              (el.duration || el.currentTime + 0.1) - 0.05,
              el.currentTime + 0.1
            );
          } catch {
            // ignore
          }
          el.play().catch(() => undefined);
        }

        // 4) 6.5s stuck -> range request dubara (fresh bytes)
        if (stuckFor > STALL_RELOAD_MS) {
          lastProgressAt.current = Date.now();
          reloadCount.current += 1;

          if (reloadCount.current > 3 && modeRef.current === "edge" && fallbackSrc) {
            // Edge worker atak gaya -> seedha Vercel API se chalao
            applyMode("direct", "Direct Vercel Stream");
            const keepAt = el.currentTime;
            el.src = fallbackSrc;
            el.load();
            el.currentTime = keepAt;
            el.play().catch(() => undefined);
            reloadCount.current = 0;
            return;
          }

          const keepAt = el.currentTime;
          el.load();
          try {
            el.currentTime = keepAt;
          } catch {
            // ignore
          }
          el.play().catch(() => undefined);
        }
      } catch {
        // ignore
      }
    }, GAP_CHECK_MS);

    return () => clearInterval(timer);
  }, [video, fallbackSrc, applyMode]);

  // -------------------------------------------------------------- media events
  const handleWaiting = () => {
    if (modeRef.current !== "offline") setBuffering(true);
  };
  const handlePlaying = () => {
    setBuffering(false);
    setFatalError("");
    lastProgressAt.current = Date.now();
    reloadCount.current = 0;
  };
  const handleError = () => {
    setBuffering(false);
    const el = video.current;
    const code = el?.error?.code || 0;

    // Network/decode error -> failover
    if (modeRef.current === "edge" && fallbackSrc) {
      const keepAt = el?.currentTime || 0;
      applyMode("direct", "Direct Vercel Stream");
      if (el) {
        el.src = fallbackSrc;
        el.load();
        try {
          el.currentTime = keepAt;
        } catch {
          // ignore
        }
        el.play().catch(() => undefined);
      }
      return;
    }

    const msg =
      code === 2
        ? "Network problem — stream beech me ruka. Retry dabayein."
        : code === 3
        ? "Video decode error — file corrupt ho sakti hai. Retry dabayein."
        : "Stream unavailable — Admin Panel me Telegram Bot Token / Session check karein.";
    setFatalError(msg);
    onError?.(msg);
  };

  const handleRetry = () => {
    const el = video.current;
    setFatalError("");
    reloadCount.current = 0;
    if (el) {
      const keepAt = el.currentTime || 0;
      el.src = currentSrc();
      el.load();
      try {
        el.currentTime = keepAt;
      } catch {
        // ignore
      }
      el.play().catch(() => undefined);
    }
  };

  // ------------------------------------------------------- Media Session (lock)
  useEffect(() => {
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title,
          artist: "Study helper Doc",
          artwork: poster ? [{ src: poster, sizes: "512x512", type: "image/jpeg" }] : [],
        });
      }
    } catch {
      // ignore
    }
  }, [title, poster]);

  const modeBadge =
    mode === "offline"
      ? { label: "OFFLINE", cls: "border-emerald-400/50 bg-emerald-500/20 text-emerald-200", Icon: WifiOff }
      : mode === "edge"
      ? { label: "EDGE", cls: "border-cyan-400/50 bg-cyan-500/20 text-cyan-200", Icon: Zap }
      : { label: "DIRECT", cls: "border-purple-400/50 bg-purple-500/20 text-purple-200", Icon: Zap };

  return (
    <div className={`relative h-full w-full bg-black ${className}`}>
      <video
        ref={video}
        poster={poster}
        controls
        playsInline
        preload="auto"
        controlsList="nodownload noplaybackrate"
        onWaiting={handleWaiting}
        onStalled={handleWaiting}
        onPlaying={handlePlaying}
        onCanPlay={handlePlaying}
        onError={handleError}
        className="h-full w-full bg-black object-contain"
      />

      {/* Status badge (engine diagnostics) */}
      <div className="pointer-events-none absolute left-2 top-2 z-20 flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-wider backdrop-blur ${modeBadge.cls}`}
        >
          <modeBadge.Icon className="h-2.5 w-2.5" />
          {modeBadge.label}
        </span>
        {engineInfo && (
          <span className="rounded-full border border-white/20 bg-black/60 px-2 py-0.5 text-[9px] font-bold text-slate-300 backdrop-blur">
            {engineInfo}
          </span>
        )}
        {mode !== "offline" && bufferAhead > 0 && (
          <span className="rounded-full border border-white/20 bg-black/60 px-2 py-0.5 text-[9px] font-bold text-slate-300 backdrop-blur">
            Buffer {bufferAhead}s
          </span>
        )}
      </div>

      {resumedLabel && (
        <div className="pointer-events-none absolute bottom-16 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/80 px-3 py-1 text-[10px] font-bold text-cyan-200">
          {resumedLabel}
        </div>
      )}

      {buffering && !fatalError && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/45">
          <Loader2 className="h-9 w-9 animate-spin text-cyan-300" />
          <span className="mt-2 rounded-full bg-black/75 px-3 py-1 text-[11px] font-bold text-cyan-200">
            Please wait, buffering HD chunk...
          </span>
          {gapJumps > 0 && (
            <span className="mt-1 text-[9px] font-bold text-slate-400">
              smooth-gap fixes: {gapJumps}
            </span>
          )}
        </div>
      )}

      {fatalError && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/88 p-6 text-center">
          <p className="max-w-sm text-sm font-bold text-rose-300">{fatalError}</p>
          <button
            type="button"
            onClick={handleRetry}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-xs font-black uppercase text-slate-950 active:scale-95"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry Stream
          </button>
        </div>
      )}
    </div>
  );
}
