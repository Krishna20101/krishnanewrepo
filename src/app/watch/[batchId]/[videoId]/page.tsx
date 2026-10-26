"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Check,
  Clock,
  Download,
  FastForward,
  FileText,
  Gauge,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  Rewind,
  RotateCw,
  Share2,
  Sparkles,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import GlowingBackButton from "@/components/GlowingBackButton";
import SafeImage from "@/components/SafeImage";
import LoginGateCard from "@/components/LoginGateCard";
import PleaseWaitScreen from "@/components/PleaseWaitScreen";
import SmartVideoPlayer from "@/components/SmartVideoPlayer";
import { formatBytesHuman } from "@/lib/clientDownloads";
import { apiUrl } from "@/config/siteConfig";

interface SiblingVideo {
  id: string;
  title: string;
  thumbnail: string;
  uploadedAt: string;
  hasAttachedPdf: boolean;
  hasRealPdf?: boolean;
}

interface WatchApiResponse {
  ok: boolean;
  batch: { id: string; name: string; thumbnail: string };
  video: SiblingVideo;
  folderTitle: string;
  folderId: string | null;
  folderPath: string[];
  embedUrl: string;
  watchUrl: string;
  youtubeId: string | null;
  telegramStreamUrl: string;
  directStreamUrl?: string;
  isYoutubeOnly?: boolean;
  fileSize?: number;
  allowVideoDownload?: boolean;
  siblings: SiblingVideo[];
}

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 1.75, 2];

export default function WatchLecturePage() {
  const params = useParams<{ batchId: string; videoId: string }>();
  const router = useRouter();
  const {
    isHydrated,
    isLoggedIn,
    openPdfComingSoon,
    config,
    downloadsList,
    startMediaDownload,
    pauseMediaDownload,
    getOfflineMediaUrl,
    releaseOfflineMediaUrl,
    navigateWithWait,
  } = useApp();

  const batchId = decodeURIComponent(String(params.batchId || ""));
  const videoId = decodeURIComponent(String(params.videoId || ""));

  const [data, setData] = useState<WatchApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [videoBuffering, setVideoBuffering] = useState(false);
  const [streamError, setStreamError] = useState("");
  const [playerSource, setPlayerSource] = useState<"TELEGRAM" | "YOUTUBE">(
    "TELEGRAM"
  );
  const [playbackRate, setPlaybackRate] = useState(1);
  const [offlineUrl, setOfflineUrl] = useState<string | null>(null);
  const [streamModeInfo, setStreamModeInfo] = useState("");
  const [isRotatedLandscape, setIsRotatedLandscape] = useState(false);
  const [copied, setCopied] = useState(false);

  const playerShellRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showBufferingDelayed = useCallback(() => {
    if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);
    bufferTimerRef.current = setTimeout(() => {
      setVideoBuffering(true);
    }, 450);
  }, []);

  const hideBufferingNow = useCallback(() => {
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    setVideoBuffering(false);
  }, []);

  useEffect(() => {
    return () => {
      if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isLoggedIn || !batchId || !videoId) return;
    let active = true;
    setLoading(true);
    setStreamError("");

    fetch(
      apiUrl(
        `/api/video/${encodeURIComponent(batchId)}/${encodeURIComponent(videoId)}`
      ),
      { cache: "no-store" }
    )
      .then((r) => r.json())
      .then((res: WatchApiResponse) => {
        if (active && res?.ok) {
          setData(res);
          if (res.telegramStreamUrl) {
            setPlayerSource("TELEGRAM");
          } else if (res.embedUrl) {
            setPlayerSource("YOUTUBE");
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [batchId, videoId, isLoggedIn]);

  const dlRecordId = `VIDEO_${batchId}_${videoId}`;

  // 📥 OFFLINE VAULT: agar ye lecture phone me save hai to internet ke bina chalegi
  useEffect(() => {
    let active = true;
    const record = downloadsList.find((x) => x.id === dlRecordId);
    if (record?.status === "completed" && record.hasOfflineBlob) {
      getOfflineMediaUrl(dlRecordId, "VIDEO")
        .then((url) => {
          if (active) setOfflineUrl(url);
        })
        .catch(() => undefined);
    } else if (active) {
      setOfflineUrl(null);
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlRecordId, downloadsList]);

  useEffect(() => {
    return () => {
      // Object URL cache SmartVideoPlayer/vault me rehta hai (dubara use hota hai)
      void releaseOfflineMediaUrl;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSpeedCycle = () => {
    const nextIdx =
      (SPEED_OPTIONS.indexOf(playbackRate) + 1) % SPEED_OPTIONS.length;
    const nextSpeed = SPEED_OPTIONS[nextIdx];
    setPlaybackRate(nextSpeed);
    if (videoRef.current) {
      videoRef.current.playbackRate = nextSpeed;
    }
  };

  const handleSeekOffset = (deltaSec: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(
      0,
      Math.min(
        videoRef.current.duration || Infinity,
        videoRef.current.currentTime + deltaSec
      )
    );
  };

  const handleToggleLandscape = useCallback(async () => {
    const nextState = !isRotatedLandscape;

    if (nextState) {
      let lockedNatively = false;
      try {
        const el = playerShellRef.current;
        if (el && el.requestFullscreen && window.innerWidth < 1024) {
          await el.requestFullscreen();
          const scr = screen as Screen & {
            orientation?: { lock?: (mode: string) => Promise<void> };
          };
          if (scr.orientation?.lock) {
            await scr.orientation.lock("landscape");
            lockedNatively = true;
          }
        }
      } catch {
        // Fallback to CSS rotation
      }

      if (!lockedNatively && document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          // ignore
        }
      }
      setIsRotatedLandscape(true);
    } else {
      try {
        const scr = screen as Screen & {
          orientation?: { unlock?: () => void };
        };
        scr.orientation?.unlock?.();
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
      } catch {
        // ignore
      }
      setIsRotatedLandscape(false);
    }
  }, [isRotatedLandscape]);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && window.innerWidth > window.innerHeight) {
        setIsRotatedLandscape(false);
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const handleBackToChapter = () => {
    if (isRotatedLandscape) {
      setIsRotatedLandscape(false);
      return;
    }
    if (data?.folderId) {
      router.push(
        `/batch/${encodeURIComponent(batchId)}?folderId=${encodeURIComponent(
          data.folderId
        )}`
      );
    } else {
      router.push(`/batch/${encodeURIComponent(batchId)}`);
    }
  };

  const handleShare = async () => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    try {
      if (navigator.share) {
        await navigator.share({
          title: data?.video?.title || config.appName,
          url,
        });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleOpenNotesPdf = () => {
    if (data?.video?.hasRealPdf) {
      navigateWithWait(
        `/pdf/${encodeURIComponent(batchId)}/${encodeURIComponent(videoId)}`,
        "Please wait, opening PDF notes..."
      );
    } else {
      openPdfComingSoon(data?.video?.title);
    }
  };

  const currentDownload = downloadsList.find((x) => x.id === dlRecordId);

  const handleStartVideoDownload = () => {
    if (!data?.telegramStreamUrl || !data.video) return;
    startMediaDownload({
      batchId,
      batchName: data.batch.name,
      itemId: videoId,
      title: data.video.title,
      kind: "VIDEO",
      thumbnail: data.video.thumbnail,
      streamUrl: data.telegramStreamUrl,
      knownSize: data.fileSize,
    });
  };

  if (!isHydrated) {
    return <PleaseWaitScreen title="Please wait, loading..." />;
  }
  if (!isLoggedIn) return <LoginGateCard />;

  const applyCssForceRotate =
    isRotatedLandscape &&
    typeof window !== "undefined" &&
    window.innerHeight >= window.innerWidth;

  const hasBothSources = Boolean(data?.telegramStreamUrl && data?.embedUrl);

  return (
    <div
      className="mx-auto min-h-screen max-w-5xl bg-[#04050e] pb-16 select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Top Player Header */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#050716]/95 px-4 py-3 backdrop-blur-md">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <GlowingBackButton onClick={handleBackToChapter} />
            <div className="min-w-0">
              <h1 className="truncate text-sm sm:text-base font-extrabold text-white">
                {data?.video?.title || "Please wait, loading lecture..."}
              </h1>
              <p className="truncate text-[11px] font-semibold text-cyan-300/90">
                {config.appName} • {data?.folderTitle || "Class Video"}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleToggleLandscape}
            title="Turn / Rotate Screen"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-purple-400/50 bg-purple-500/15 px-3 py-2 text-xs font-extrabold text-purple-200 transition hover:bg-purple-500/25 active:scale-95"
          >
            <RotateCw className="h-4 w-4 text-cyan-300" />
            <span>Turn</span>
          </button>
        </div>
      </header>

      {/* Main Theater Player Container */}
      <div className="mx-auto max-w-4xl sm:px-4 sm:pt-5">
        <div
          ref={playerShellRef}
          className={
            applyCssForceRotate
              ? "forced-landscape-player"
              : "relative overflow-hidden bg-black sm:rounded-3xl sm:border sm:border-cyan-400/25"
          }
        >
          {isRotatedLandscape && (
            <div className="absolute right-4 top-4 z-50 flex items-center gap-2">
              <button
                type="button"
                onClick={handleToggleLandscape}
                className="flex items-center gap-1.5 rounded-full border border-cyan-400/60 bg-black/85 px-3.5 py-2 text-xs font-black uppercase tracking-wider text-cyan-200"
              >
                <Minimize2 className="h-4 w-4" />
                <span>Exit Rotate</span>
              </button>
            </div>
          )}

          <div
            className={
              applyCssForceRotate
                ? "relative h-full w-full"
                : "relative aspect-video w-full bg-[#050714]"
            }
          >
            {loading ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                <Loader2 className="h-10 w-10 animate-spin text-cyan-300" />
                <p className="text-xs font-black uppercase tracking-widest text-cyan-300">
                  Please wait, loading video stream...
                </p>
              </div>
            ) : playerSource === "TELEGRAM" && data?.telegramStreamUrl ? (
              <>
                <SmartVideoPlayer
                  primarySrc={data.telegramStreamUrl}
                  fallbackSrc={data.directStreamUrl || data.telegramStreamUrl}
                  offlineSrc={offlineUrl}
                  poster={data.video?.thumbnail || config.defaultImageUrl}
                  title={data.video?.title || "Lecture"}
                  resumeKey={`${batchId}_${videoId}`}
                  videoRef={videoRef}
                  onModeChange={(m, info) =>
                    setStreamModeInfo(
                      m === "offline"
                        ? "OFFLINE — phone se chal raha hai (0% internet)"
                        : info
                        ? `${m.toUpperCase()} — ${info}`
                        : m.toUpperCase()
                    )
                  }
                  onError={(msg) => {
                    hideBufferingNow();
                    setStreamError(msg);
                  }}
                  className="aspect-video w-full"
                />

                {streamModeInfo && (
                  <div className="pointer-events-none absolute bottom-2 right-2 z-20 rounded-full bg-black/70 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wide text-emerald-300">
                    {streamModeInfo}
                  </div>
                )}
              </>
            ) : data?.embedUrl ? (
              <iframe
                src={data.embedUrl}
                title={data.video?.title || "Lecture Video"}
                className="h-full w-full border-0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
              />
            ) : (
              <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden p-6 text-center">
                <SafeImage
                  src={data?.video?.thumbnail}
                  fallbackSrc={config.defaultImageUrl}
                  alt={data?.video?.title || "Lecture"}
                  className="absolute inset-0 h-full w-full object-cover opacity-20"
                />
                <div className="relative z-10 max-w-md rounded-3xl border border-cyan-400/30 bg-[#090d24]/95 p-6">
                  <Sparkles className="mx-auto mb-2.5 h-8 w-8 text-cyan-300" />
                  <h2 className="text-lg font-black text-white">
                    Video Stream Link Pending
                  </h2>
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
                    Is lecture ka Telegram ya YouTube stream link Admin Panel se
                    jald hi update kiya jayega. Stay tuned!
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Custom Speed & Skip Bar when playing Protected Telegram Stream */}
        {playerSource === "TELEGRAM" && data?.telegramStreamUrl && (
          <div className="px-4 pt-3 sm:px-0">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-cyan-400/20 bg-[#090d26] px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleSeekOffset(-10)}
                  className="inline-flex items-center gap-1 rounded-xl border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-extrabold text-slate-200 active:scale-95"
                >
                  <Rewind className="h-3.5 w-3.5 text-cyan-300" />
                  <span>-10s</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSeekOffset(10)}
                  className="inline-flex items-center gap-1 rounded-xl border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-extrabold text-slate-200 active:scale-95"
                >
                  <span>+10s</span>
                  <FastForward className="h-3.5 w-3.5 text-cyan-300" />
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSpeedCycle}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-purple-400/40 bg-purple-500/15 px-3 py-1.5 text-xs font-black text-purple-200"
                >
                  <Gauge className="h-3.5 w-3.5 text-cyan-300" />
                  <span>Speed: {playbackRate}x</span>
                </button>

                {hasBothSources && (
                  <button
                    type="button"
                    onClick={() =>
                      setPlayerSource((s) =>
                        s === "TELEGRAM" ? "YOUTUBE" : "TELEGRAM"
                      )
                    }
                    className="rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-xs font-black text-amber-200"
                  >
                    Switch Server
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Player Action Bar */}
        <div className="px-4 pt-4 sm:px-0">
          <div className="glass-card flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-white/10 p-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handleShare}
                className="inline-flex items-center gap-1.5 rounded-2xl border border-white/15 bg-white/5 px-3.5 py-2.5 text-xs font-bold text-slate-200"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-400" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Share2 className="h-4 w-4 text-cyan-300" />
                    <span>Share</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleOpenNotesPdf}
                className="inline-flex items-center gap-1.5 rounded-2xl border border-rose-400/40 bg-rose-500/15 px-3.5 py-2.5 text-xs font-extrabold text-rose-200"
              >
                <FileText className="h-4 w-4 text-rose-400" />
                <span>
                  {data?.video?.hasRealPdf ? "Open Notes PDF" : "Notes PDF"}
                </span>
              </button>

              {/* 📥 In-App Offline Vault Save (file phone me NAHI jati) */}
              {data?.telegramStreamUrl && data.allowVideoDownload !== false && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={currentDownload?.status === "downloading"}
                    onClick={handleStartVideoDownload}
                    className="inline-flex items-center gap-1.5 rounded-2xl border border-emerald-400/45 bg-emerald-500/15 px-3.5 py-2.5 text-xs font-extrabold text-emerald-200 transition hover:bg-emerald-500/25 disabled:opacity-75"
                  >
                    {currentDownload?.status === "downloading" ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin text-emerald-300" />
                        <span>Saving {currentDownload.progressPct}%...</span>
                      </>
                    ) : currentDownload?.status === "paused" ? (
                      <>
                        <Download className="h-4 w-4 text-amber-300" />
                        <span>Resume Save ({currentDownload.progressPct}%)</span>
                      </>
                    ) : currentDownload?.status === "completed" ? (
                      <>
                        <Check className="h-4 w-4 text-emerald-400" />
                        <span>Saved Offline in App</span>
                      </>
                    ) : (
                      <>
                        <Download className="h-4 w-4 text-emerald-300" />
                        <span>
                          Save Offline
                          {data.fileSize
                            ? ` (${formatBytesHuman(data.fileSize)})`
                            : ""}
                        </span>
                      </>
                    )}
                  </button>

                  {currentDownload?.status === "downloading" && (
                    <button
                      type="button"
                      onClick={() => pauseMediaDownload(currentDownload.id)}
                      className="rounded-2xl border border-amber-400/40 bg-amber-500/15 px-3 py-2.5 text-xs font-extrabold text-amber-200"
                    >
                      Pause
                    </button>
                  )}

                  {offlineUrl && (
                    <span className="inline-flex items-center gap-1 rounded-2xl border border-emerald-400/40 bg-emerald-500/10 px-3 py-2.5 text-[10px] font-black uppercase tracking-wide text-emerald-300">
                      ● Playing Offline
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={handleToggleLandscape}
                className="inline-flex items-center gap-2 rounded-2xl border border-cyan-400/50 bg-gradient-to-r from-cyan-500/20 to-purple-600/25 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-cyan-200 active:scale-95"
              >
                <Maximize2 className="h-4 w-4 text-cyan-300" />
                <span>Turn Screen</span>
              </button>
            </div>
          </div>

          {/* Live Download Progress Strip if downloading */}
          {currentDownload?.status === "downloading" && (
            <div className="mt-3 rounded-2xl border border-emerald-400/35 bg-emerald-500/10 p-3">
              <div className="flex items-center justify-between text-xs font-bold text-emerald-200">
                <span>
                  Please wait, lecture phone ke andar save ho raha hai (
                  {currentDownload.progressPct}%) — internet ke bina chalega...
                </span>
                <span>
                  {formatBytesHuman(currentDownload.downloadedBytes)} /{" "}
                  {formatBytesHuman(currentDownload.totalBytes)}
                </span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all"
                  style={{ width: `${currentDownload.progressPct}%` }}
                />
              </div>
            </div>
          )}

          {/* Lecture Details Card */}
          {data?.video && (
            <div className="mt-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-cyan-300">
                <span>{data.batch.name}</span>
                <span>•</span>
                <span className="text-purple-300">{data.folderTitle}</span>
              </div>
              <h2 className="mt-1.5 text-lg sm:text-xl font-black text-white">
                {data.video.title}
              </h2>
              {data.video.uploadedAt && (
                <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
                  <Clock className="h-3.5 w-3.5 text-cyan-400" />
                  <span>Uploaded: {data.video.uploadedAt}</span>
                </p>
              )}
            </div>
          )}

          {/* More Lectures in Same Chapter */}
          {data?.siblings && data.siblings.length > 1 && (
            <div className="mt-7">
              <h3 className="mb-3.5 text-xs font-black uppercase tracking-widest text-slate-300">
                More Lectures in {data.folderTitle} ({data.siblings.length})
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {data.siblings.map((item) => {
                  const isCurrent = item.id === videoId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        if (!isCurrent) {
                          navigateWithWait(
                            `/watch/${encodeURIComponent(
                              batchId
                            )}/${encodeURIComponent(item.id)}`,
                            "Please wait, switching lecture..."
                          );
                        }
                      }}
                      className={`glass-card perf-card-item flex items-center gap-3.5 rounded-2xl border p-3 text-left transition ${
                        isCurrent
                          ? "border-cyan-400/60 bg-cyan-500/10"
                          : "border-white/10 hover:border-purple-400/40"
                      }`}
                    >
                      <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-xl bg-[#0d122d]">
                        <SafeImage
                          src={item.thumbnail}
                          fallbackSrc={config.defaultImageUrl}
                          alt={item.title}
                          className="h-full w-full object-cover"
                        />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/35">
                          <Play
                            className={`h-4 w-4 ${
                              isCurrent
                                ? "fill-cyan-300 text-cyan-300"
                                : "fill-white text-white"
                            }`}
                          />
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-xs font-extrabold text-white">
                          {item.title}
                        </p>
                        {isCurrent && (
                          <span className="mt-1 inline-block text-[10px] font-black uppercase tracking-wider text-cyan-300">
                            ● Playing Now
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
