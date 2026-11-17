"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowUpRight,
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
  Radio,
  Rewind,
  RotateCw,
  Send,
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
  telegramBotUrl?: string;
  telegramBotUsername?: string;
  telegramChannelUrl?: string;
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
      className="mx-auto min-h-screen max-w-5xl pb-16 select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Top Player Header */}
      <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#08090f]/92 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <GlowingBackButton onClick={handleBackToChapter} />
            <div className="min-w-0">
              <h1 className="truncate font-display text-[15px] font-semibold text-sand-100">
                {data?.video?.title || "Please wait, loading lecture..."}
              </h1>
              <p className="truncate text-[10.5px] font-medium text-sand-500">
                {config.appName} · {data?.folderTitle || "Lecture"}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleToggleLandscape}
            title="Turn / Rotate Screen"
            className="btn-ghost shrink-0 px-3 py-2 text-[11px] uppercase tracking-[0.1em]"
          >
            <RotateCw className="h-4 w-4 text-ember-400" />
            <span>Turn</span>
          </button>
        </div>
      </header>

      {/* ══════════════ MAIN STAGE ══════════════ */}
      <div className="mx-auto max-w-4xl sm:px-4 sm:pt-5">
        <div className="relative overflow-hidden rounded-card border border-white/[0.08] bg-ink-950 sm:border">
          <div className="relative aspect-video w-full bg-ink-900">
            {loading ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-ember-400" />
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-sand-400">
                  Loading lecture
                </p>
              </div>
            ) : data?.embedUrl ? (
              /* YouTube-embedded lecture (no Telegram file) */
              <iframe
                src={data.embedUrl}
                title={data.video?.title || "Lecture"}
                className="h-full w-full border-0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
              />
            ) : data?.telegramBotUrl ? (
              /* ═══ TELEGRAM GATEWAY STAGE ═══ */
              <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden px-6 text-center">
                <SafeImage
                  src={data.video?.thumbnail}
                  fallbackSrc={config.defaultImageUrl}
                  alt={data.video?.title || "Lecture"}
                  className="absolute inset-0 h-full w-full object-cover opacity-[0.16]"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/85 to-ink-950/60" />

                <div className="relative z-10 w-full max-w-sm">
                  <span className="inline-flex items-center gap-1.5 rounded-tag border border-ember-500/35 bg-ember-500/10 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.16em] text-ember-300">
                    <Send className="h-3 w-3" />
                    Telegram delivery
                  </span>

                  <h2 className="mt-3 font-display text-[19px] font-semibold leading-snug text-sand-100 sm:text-[22px]">
                    Open in Telegram to watch
                  </h2>
                  <p className="mx-auto mt-1.5 max-w-xs text-[12px] leading-relaxed text-sand-400">
                    The lecture is delivered privately by our bot. It expires
                    automatically after 3 hours.
                  </p>

                  <a
                    href={data.telegramBotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-ember mt-4 w-full py-3.5 text-[12px] uppercase tracking-[0.14em]"
                  >
                    <Send className="h-4 w-4" />
                    <span>Open in Telegram</span>
                    <ArrowUpRight className="h-4 w-4" />
                  </a>

                  {data.telegramChannelUrl && (
                    <a
                      href={data.telegramChannelUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-ghost mt-2 w-full py-2.5 text-[11px] uppercase tracking-[0.12em]"
                    >
                      <Radio className="h-3.5 w-3.5" />
                      <span>Join our channel</span>
                    </a>
                  )}

                  <p className="mt-3 text-[10.5px] leading-relaxed text-sand-500">
                    Link valid for 20 minutes. In Telegram, press{" "}
                    <span className="font-semibold text-sand-300">Start</span> and
                    the video will be sent to you.
                  </p>
                </div>
              </div>
            ) : data?.telegramStreamUrl ? (
              /* Legacy in-site stream (fallback if bot not configured) */
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
                        ? "OFFLINE"
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
                  <div className="pointer-events-none absolute bottom-2 right-2 z-20 rounded bg-ink-950/80 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-sage-300">
                    {streamModeInfo}
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
                <Sparkles className="h-6 w-6 text-ember-400" />
                <p className="font-display text-[16px] font-semibold text-sand-100">
                  Stream not linked yet
                </p>
                <p className="max-w-xs text-[12px] leading-relaxed text-sand-400">
                  This lecture has no stream yet. Please check back soon.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Player Action Bar */}
        <div className="px-4 pt-4 sm:px-0">
          <div className="surface flex flex-wrap items-center justify-between gap-3 rounded-card p-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handleShare}
                className="btn-ghost px-3.5 py-2.5 text-[11px] uppercase tracking-[0.1em]"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 text-sage-400" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Share2 className="h-4 w-4 text-sand-300" />
                    <span>Share</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleOpenNotesPdf}
                className="btn-ghost px-3.5 py-2.5 text-[11px] uppercase tracking-[0.1em]"
              >
                <FileText className="h-4 w-4 text-sage-400" />
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
                    className="btn-ghost px-3.5 py-2.5 text-[11px] uppercase tracking-[0.1em] disabled:opacity-75"
                  >
                    {currentDownload?.status === "downloading" ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin text-ember-400" />
                        <span>Saving {currentDownload.progressPct}%...</span>
                      </>
                    ) : currentDownload?.status === "paused" ? (
                      <>
                        <Download className="h-4 w-4 text-ember-400" />
                        <span>Resume Save ({currentDownload.progressPct}%)</span>
                      </>
                    ) : currentDownload?.status === "completed" ? (
                      <>
                        <Check className="h-4 w-4 text-sage-400" />
                        <span>Saved Offline in App</span>
                      </>
                    ) : (
                      <>
                        <Download className="h-4 w-4 text-sage-400" />
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
                      className="btn-ghost px-3 py-2.5 text-[11px]"
                    >
                      Pause
                    </button>
                  )}

                  {offlineUrl && (
                    <span className="chip chip-sage">
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
                className="btn-ghost px-4 py-2.5 text-[11px] uppercase tracking-[0.12em] active:scale-95"
              >
                <Maximize2 className="h-4 w-4 text-ember-400" />
                <span>Turn Screen</span>
              </button>
            </div>
          </div>

          {/* Live Download Progress Strip if downloading */}
          {currentDownload?.status === "downloading" && (
            <div className="mt-3 rounded-xl border border-white/[0.08] bg-ink-900/70 p-3">
              <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-sand-300">
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
                  className="h-full rounded-full bg-gradient-to-r from-ember-500 to-ember-300 transition-all"
                  style={{ width: `${currentDownload.progressPct}%` }}
                />
              </div>
            </div>
          )}

          {/* Lecture Details Card */}
          {data?.video && (
            <div className="mt-4 rounded-card border border-white/[0.08] bg-ink-900/60 p-4">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-ember-400">
                <span>{data.batch.name}</span>
                <span>•</span>
                <span className="text-sage-400">{data.folderTitle}</span>
              </div>
              <h2 className="mt-1.5 font-display text-[19px] font-semibold text-sand-100">
                {data.video.title}
              </h2>
              {data.video.uploadedAt && (
                <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
                  <Clock className="h-3.5 w-3.5 text-sand-500" />
                  <span>Uploaded: {data.video.uploadedAt}</span>
                </p>
              )}
            </div>
          )}

          {/* More Lectures in Same Chapter */}
          {data?.siblings && data.siblings.length > 1 && (
            <div className="mt-7">
              <h3 className="mb-3.5 text-[11px] font-bold uppercase tracking-[0.18em] text-sand-400">
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
                      className={`surface perf-card-item flex items-center gap-3.5 rounded-xl border p-3 text-left transition ${
                        isCurrent
                          ? "border-ember-500/45 bg-ember-500/[0.07]"
                          : "border-white/[0.08] hover:border-white/20"
                      }`}
                    >
                      <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-ink-850">
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
                                ? "fill-ember-400 text-ember-400"
                                : "fill-sand-100 text-sand-100"
                            }`}
                          />
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-[12.5px] font-semibold text-sand-100">
                          {item.title}
                        </p>
                        {isCurrent && (
                          <span className="mt-1 inline-block text-[9.5px] font-extrabold uppercase tracking-[0.14em] text-ember-400">
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
