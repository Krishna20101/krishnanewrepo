"use client";

import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  Download,
  FileText,
  HardDriveDownload,
  Loader2,
  Pause,
  Play,
  PlayCircle,
  Trash2,
  X,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import GlowingBackButton from "@/components/GlowingBackButton";
import BottomDock from "@/components/BottomDock";
import SafeImage from "@/components/SafeImage";
import LoginGateCard from "@/components/LoginGateCard";
import PleaseWaitScreen from "@/components/PleaseWaitScreen";
import {
  formatBytesHuman,
  getOfflineBlobFromIdb,
  getVaultUsage,
  requestPersistentStorage,
  SavedDownloadItem,
  triggerBrowserBlobSave,
} from "@/lib/clientDownloads";

export default function DownloadsPage() {
  const {
    isHydrated,
    isLoggedIn,
    downloadsList,
    removeSavedDownload,
    startMediaDownload,
    pauseMediaDownload,
    resumeMediaDownload,
    navigateWithWait,
    config,
  } = useApp();

  const [activeTab, setActiveTab] = useState<"VIDEO" | "PDF">("VIDEO");
  const [offlineViewer, setOfflineViewer] = useState<{
    kind: "VIDEO" | "PDF";
    title: string;
    url: string;
  } | null>(null);
  const [vaultUsage, setVaultUsage] = useState({ usage: 0, quota: 0 });

  // Vault storage usage + persistent storage request (Chrome vault khali na kare)
  useEffect(() => {
    if (!isLoggedIn) return;
    let active = true;
    void requestPersistentStorage();
    getVaultUsage().then((u) => {
      if (active) setVaultUsage({ usage: u.usage, quota: u.quota });
    });
    const t = setInterval(() => {
      getVaultUsage().then((u) => {
        if (active) setVaultUsage({ usage: u.usage, quota: u.quota });
      });
    }, 4000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [isLoggedIn]);

  if (!isHydrated) {
    return <PleaseWaitScreen title="Please wait, loading downloads..." />;
  }
  if (!isLoggedIn) return <LoginGateCard />;

  const videoDownloads = downloadsList.filter((d) => d.kind === "VIDEO");
  const pdfDownloads = downloadsList.filter((d) => d.kind === "PDF");
  const currentList = activeTab === "VIDEO" ? videoDownloads : pdfDownloads;

  const handleOpenSavedItem = async (item: SavedDownloadItem) => {
    // 1. Try offline IndexedDB vault first (mobile internet OFF par bhi chalega!)
    const cachedBlob = await getOfflineBlobFromIdb(
      item.id,
      item.kind === "PDF" ? "application/pdf" : "video/mp4"
    );
    if (cachedBlob) {
      const objUrl = URL.createObjectURL(cachedBlob);
      setOfflineViewer({
        kind: item.kind,
        title: item.title,
        url: objUrl,
      });
      return;
    }

    // 2. Otherwise open online player / PDF viewer seamlessly
    if (item.kind === "VIDEO") {
      navigateWithWait(
        `/watch/${encodeURIComponent(item.batchId)}/${encodeURIComponent(
          item.itemId
        )}`,
        "Please wait, opening lecture..."
      );
    } else {
      navigateWithWait(
        `/pdf/${encodeURIComponent(item.batchId)}/${encodeURIComponent(
          item.itemId
        )}`,
        "Please wait, opening PDF..."
      );
    }
  };

  /** Retry / Resume in-app vault save (browser me file NAHI jati) */
  const handleRetrySave = async (item: SavedDownloadItem) => {
    if (item.status === "paused" || item.status === "error") {
      await resumeMediaDownload(item.id);
      return;
    }
    await startMediaDownload({
      batchId: item.batchId,
      batchName: item.batchName,
      itemId: item.itemId,
      title: item.title,
      kind: item.kind,
      thumbnail: item.thumbnail,
      streamUrl: item.streamUrl,
      knownSize: item.totalBytes,
    });
  };

  /** OPTIONAL: student khud chahe to phone me file nikal sake (explicit click) */
  const handleExportToPhone = async (item: SavedDownloadItem) => {
    const cachedBlob = await getOfflineBlobFromIdb(
      item.id,
      item.kind === "PDF" ? "application/pdf" : "video/mp4"
    );
    if (cachedBlob) {
      const ext = item.kind === "PDF" ? "pdf" : "mp4";
      triggerBrowserBlobSave(cachedBlob, `${item.title}.${ext}`);
    }
  };

  const closeOfflineModal = () => {
    if (offlineViewer?.url) {
      URL.revokeObjectURL(offlineViewer.url);
    }
    setOfflineViewer(null);
  };

  return (
    <div className="mx-auto min-h-screen max-w-5xl pb-28">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#07091b]/95 px-4 py-3.5 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <GlowingBackButton fallbackHref="/" />
          <div>
            <h1 className="text-xl font-black uppercase tracking-wider text-white">
              DOWNLOADS ({downloadsList.length})
            </h1>
            <p className="text-xs font-medium text-slate-400">
              Aapke downloaded Lectures aur PDF Notes yahan rehte hain.
            </p>
          </div>
        </div>
      </header>

      <main className="px-4 pt-5">
        {/* VIDEO | PDF Toggle Pill Bar */}
        <div className="glass-card mx-auto mb-6 grid max-w-xl grid-cols-2 gap-2 rounded-2xl border border-white/10 p-2">
          <button
            type="button"
            onClick={() => setActiveTab("VIDEO")}
            className={`flex items-center justify-center gap-2 rounded-xl py-3 text-xs font-black uppercase tracking-widest transition-all ${
              activeTab === "VIDEO"
                ? "border border-indigo-400/60 bg-gradient-to-r from-indigo-600 to-purple-600 text-white"
                : "text-slate-300 hover:bg-white/5"
            }`}
          >
            <PlayCircle className="h-4 w-4" />
            <span>VIDEO ({videoDownloads.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("PDF")}
            className={`flex items-center justify-center gap-2 rounded-xl py-3 text-xs font-black uppercase tracking-widest transition-all ${
              activeTab === "PDF"
                ? "border border-rose-400/60 bg-gradient-to-r from-rose-600 to-pink-600 text-white"
                : "text-slate-300 hover:bg-white/5"
            }`}
          >
            <FileText className="h-4 w-4" />
            <span>PDF ({pdfDownloads.length})</span>
          </button>
        </div>

        {/* In-App Vault storage meter */}
        <div className="glass-card mx-auto mb-5 max-w-xl rounded-2xl border border-white/10 p-3.5">
          <div className="flex items-center justify-between text-[11px] font-bold text-slate-300">
            <span className="inline-flex items-center gap-1.5 text-emerald-300">
              <HardDriveDownload className="h-3.5 w-3.5" />
              In-App Offline Vault
            </span>
            <span>
              {formatBytesHuman(vaultUsage.usage)}
              {vaultUsage.quota ? ` / ${formatBytesHuman(vaultUsage.quota)}` : ""}
            </span>
          </div>
          {vaultUsage.quota > 0 && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round((vaultUsage.usage / vaultUsage.quota) * 100)
                  )}%`,
                }}
              />
            </div>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
            Saved lectures sirf isi website ke andar rehte hain (phone ke
            Downloads folder me file nahi jati) — internet band ho tab bhi
            chalega.
          </p>
        </div>

        {currentList.length === 0 ? (
          <div className="glass-card mx-auto my-10 max-w-md rounded-3xl border border-white/10 p-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-purple-400/35 bg-purple-500/15">
              <Download className="h-8 w-8 text-purple-300" />
            </div>
            <h2 className="text-lg font-black text-white">
              Abhi Koi {activeTab === "VIDEO" ? "Video" : "PDF"} Download Nahi
              Hai
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">
              Kisi bhi Lecture ya PDF page par jakar{" "}
              <strong className="text-emerald-300">Save Offline</strong> button
              dabayein — lecture isi website ke andar save hoga aur internet
              band hone par bhi chalega!
            </p>
          </div>
        ) : (
          <div className="space-y-3.5">
            {currentList.map((item) => (
              <div
                key={item.id}
                className="glass-card perf-card-item rounded-3xl border border-white/10 p-4"
              >
                <div className="flex items-start gap-3.5">
                  {item.kind === "VIDEO" ? (
                    <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-2xl bg-[#0d122d]">
                      <SafeImage
                        src={item.thumbnail}
                        fallbackSrc={config.defaultImageUrl}
                        alt={item.title}
                        className="h-full w-full object-cover"
                      />
                    </div>
                  ) : (
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-rose-400/40 bg-rose-500/20 text-rose-300">
                      <FileText className="h-7 w-7" />
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-bold text-cyan-300">
                      {item.batchName}
                    </p>
                    <h3 className="mt-0.5 line-clamp-2 text-sm sm:text-base font-extrabold text-white">
                      {item.title}
                    </h3>

                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] font-semibold">
                      {item.status === "downloading" ? (
                        <span className="inline-flex items-center gap-1 text-amber-300">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>
                            Please wait, vault me save ho raha hai{" "}
                            {item.progressPct}% (
                            {formatBytesHuman(item.downloadedBytes)} /{" "}
                            {formatBytesHuman(item.totalBytes)})
                          </span>
                        </span>
                      ) : item.status === "paused" ? (
                        <span className="inline-flex items-center gap-1 text-amber-200">
                          <Pause className="h-3.5 w-3.5" />
                          <span>
                            Paused at {item.progressPct}% (
                            {formatBytesHuman(item.downloadedBytes)}) — Resume
                            dabayein
                          </span>
                        </span>
                      ) : item.status === "completed" ? (
                        <span className="inline-flex items-center gap-1 text-emerald-300">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>
                            Saved in App
                            {item.totalBytes
                              ? ` • ${formatBytesHuman(item.totalBytes)}`
                              : ""}
                            {item.hasOfflineBlob ? " • Offline Ready" : ""}
                          </span>
                        </span>
                      ) : (
                        <span className="text-rose-300">
                          {item.errorMsg || "Save interrupted — Retry dabayein"}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Progress Bar when actively saving */}
                {(item.status === "downloading" || item.status === "paused") && (
                  <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-emerald-400 transition-all"
                      style={{ width: `${item.progressPct}%` }}
                    />
                  </div>
                )}

                {/* Action Buttons */}
                <div className="mt-3.5 flex flex-wrap items-center gap-2">
                  {item.status === "downloading" ? (
                    <button
                      type="button"
                      onClick={() => pauseMediaDownload(item.id)}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-2xl border border-amber-400/45 bg-amber-500/15 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-amber-200"
                    >
                      <Pause className="h-3.5 w-3.5" />
                      <span>Pause Save</span>
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => handleOpenSavedItem(item)}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2.5 text-xs font-black uppercase tracking-wider text-white"
                      >
                        <Play className="h-3.5 w-3.5 fill-white" />
                        <span>
                          {item.status === "completed"
                            ? item.kind === "VIDEO"
                              ? "Play Offline"
                              : "Read Offline"
                            : item.kind === "VIDEO"
                            ? "Play Lecture"
                            : "Open PDF"}
                        </span>
                      </button>

                      {item.status === "completed" ? (
                        <button
                          type="button"
                          onClick={() => handleExportToPhone(item)}
                          className="inline-flex items-center gap-1.5 rounded-2xl border border-white/15 bg-white/5 px-3.5 py-2.5 text-xs font-extrabold text-slate-200"
                          title="Phone me file bhi save karein (optional)"
                        >
                          <Download className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Export File</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleRetrySave(item)}
                          className="inline-flex items-center gap-1.5 rounded-2xl border border-emerald-400/40 bg-emerald-500/15 px-3.5 py-2.5 text-xs font-extrabold text-emerald-200"
                        >
                          <Download className="h-3.5 w-3.5" />
                          <span>
                            {item.status === "paused" ? "Resume" : "Retry"}
                          </span>
                        </button>
                      )}
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() => removeSavedDownload(item.id)}
                    className="inline-flex items-center justify-center rounded-2xl border border-rose-400/35 bg-rose-500/15 p-2.5 text-rose-300"
                    title="Remove from vault"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Instant Offline Viewer Modal when cached in IndexedDB */}
      {offlineViewer && (
        <div className="fixed inset-0 z-[90] flex flex-col bg-black/95 p-3 sm:p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="truncate text-sm font-black text-white">
              Offline Vault • {offlineViewer.title}
            </h3>
            <button
              type="button"
              onClick={closeOfflineModal}
              className="inline-flex items-center gap-1 rounded-xl border border-rose-400/50 bg-rose-500/20 px-3 py-1.5 text-xs font-black text-rose-200"
            >
              <X className="h-4 w-4" />
              <span>Close</span>
            </button>
          </div>
          <div className="flex-1 overflow-hidden rounded-2xl border border-white/15 bg-black">
            {offlineViewer.kind === "VIDEO" ? (
              <video
                src={offlineViewer.url}
                controls
                autoPlay
                playsInline
                controlsList="nodownload"
                className="h-full w-full object-contain"
              />
            ) : (
              <iframe
                src={`${offlineViewer.url}#toolbar=1&navpanes=0`}
                title={offlineViewer.title}
                className="h-full w-full border-0 bg-white"
              />
            )}
          </div>
        </div>
      )}

      <BottomDock />
    </div>
  );
}
