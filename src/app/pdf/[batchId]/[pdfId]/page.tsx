"use client";

import React, { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Check,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Pause,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import GlowingBackButton from "@/components/GlowingBackButton";
import LoginGateCard from "@/components/LoginGateCard";
import PleaseWaitScreen from "@/components/PleaseWaitScreen";
import ComingSoonState from "@/components/ComingSoonState";
import ProgressivePdfViewer from "@/components/ProgressivePdfViewer";
import { formatBytesHuman } from "@/lib/clientDownloads";
import { apiUrl } from "@/config/siteConfig";

interface PdfApiResponse {
  ok: boolean;
  batch: { id: string; name: string };
  pdf: {
    id: string;
    title: string;
    uploadedAt: string;
    fileSize: number;
    hasRealPdf: boolean;
    isTelegramChunked: boolean;
    streamUrl: string;
    directStreamUrl?: string;
  };
  folderTitle: string;
  folderId: string | null;
}

// ============================================================================
// 📄 PDF PAGE — ab PROGRESSIVE khulta hai (poori file ek saath load nahi hoti)
// ============================================================================
// Order of preference:
//   1. Offline Vault (IndexedDB) — 0 internet, instant
//   2. Telegram/Worker URL — pdf.js range requests (pehla page ~300KB me ready,
//      baaki pages scroll par apne aap)
//   3. Fallback iframe (agar pdf.js fail ho / external PDF CORS block kare)
// ============================================================================
export default function PdfWebViewerPage() {
  const params = useParams<{ batchId: string; pdfId: string }>();
  const router = useRouter();
  const {
    isHydrated,
    isLoggedIn,
    downloadsList,
    startMediaDownload,
    pauseMediaDownload,
    resumeMediaDownload,
    getOfflineMediaUrl,
  } = useApp();

  const batchId = decodeURIComponent(String(params.batchId || ""));
  const pdfId = decodeURIComponent(String(params.pdfId || ""));
  const dlRecordId = `PDF_${batchId}_${pdfId}`;

  const [meta, setMeta] = useState<PdfApiResponse | null>(null);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [offlineBlob, setOfflineBlob] = useState<Blob | null>(null);
  const [offlineData, setOfflineData] = useState<ArrayBuffer | null>(null);
  const [useIframeFallback, setUseIframeFallback] = useState(false);

  const savedRecord = downloadsList.find((x) => x.id === dlRecordId);

  // 1) PDF metadata
  useEffect(() => {
    if (!isLoggedIn || !batchId || !pdfId) return;
    let active = true;
    setLoadingMeta(true);
    setLoadError("");

    fetch(
      apiUrl(
        `/api/pdf/${encodeURIComponent(batchId)}/${encodeURIComponent(pdfId)}`
      ),
      { cache: "no-store" }
    )
      .then((r) => r.json())
      .then((data: PdfApiResponse) => {
        if (!active) return;
        setLoadingMeta(false);
        if (!data?.ok) {
          setLoadError(data ? "PDF metadata not found." : "Failed to load.");
          return;
        }
        setMeta(data);
      })
      .catch(() => {
        if (!active) return;
        setLoadingMeta(false);
        setLoadError("Network error while loading PDF.");
      });

    return () => {
      active = false;
    };
  }, [batchId, pdfId, isLoggedIn]);

  // 2) Offline vault check (agar PDF phone me saved hai)
  useEffect(() => {
    let active = true;
    if (savedRecord?.status === "completed" && savedRecord.hasOfflineBlob) {
      getOfflineMediaUrl(dlRecordId, "PDF")
        .then(async (url) => {
          if (!active || !url) return;
          try {
            const blob = await (await fetch(url)).blob();
            if (!active) return;
            setOfflineBlob(blob);
            const buf = await blob.arrayBuffer();
            if (active) setOfflineData(buf);
          } catch {
            // ignore -> stream se khul jayega
          }
        })
        .catch(() => undefined);
    } else {
      setOfflineBlob(null);
      setOfflineData(null);
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlRecordId, savedRecord?.status, savedRecord?.hasOfflineBlob]);

  if (!isHydrated) return <PleaseWaitScreen title="Please wait, loading..." />;
  if (!isLoggedIn) return <LoginGateCard />;

  const handleBack = () => {
    if (meta?.folderId) {
      router.push(
        `/batch/${encodeURIComponent(batchId)}?folderId=${encodeURIComponent(
          meta.folderId
        )}`
      );
    } else {
      router.push(`/batch/${encodeURIComponent(batchId)}`);
    }
  };

  const handleSavePdf = () => {
    if (!meta?.pdf?.streamUrl) return;
    if (savedRecord?.status === "paused") {
      void resumeMediaDownload(dlRecordId);
      return;
    }
    void startMediaDownload({
      batchId,
      batchName: meta.batch.name,
      itemId: pdfId,
      title: meta.pdf.title,
      kind: "PDF",
      streamUrl: meta.pdf.streamUrl,
      knownSize: meta.pdf.fileSize,
    });
  };

  const streamSrc =
    meta?.pdf?.streamUrl || meta?.pdf?.directStreamUrl || "";
  const isSameOrigin =
    streamSrc.startsWith("/") || streamSrc.includes("workers.dev");

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col pb-6">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#07091b]/95 px-4 py-3 backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <GlowingBackButton onClick={handleBack} />
            <div className="min-w-0">
              <h1 className="truncate text-sm sm:text-base font-extrabold text-white">
                {meta?.pdf?.title || "Please wait, loading PDF..."}
              </h1>
              <p className="truncate text-[11px] font-semibold text-rose-300">
                {meta?.batch?.name || "Class Notes"} •{" "}
                {meta?.folderTitle || "PDF Viewer"}
                {meta?.pdf?.fileSize ? ` • ${formatBytesHuman(meta.pdf.fileSize)}` : ""}
              </p>
            </div>
          </div>

          {meta?.pdf?.hasRealPdf && (
            <div className="flex flex-wrap items-center gap-2">
              {savedRecord?.status === "downloading" && (
                <button
                  type="button"
                  onClick={() => pauseMediaDownload(dlRecordId)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-xs font-extrabold text-amber-200"
                >
                  <Pause className="h-3.5 w-3.5" />
                  <span>{savedRecord.progressPct}%</span>
                </button>
              )}

              <button
                type="button"
                disabled={savedRecord?.status === "downloading"}
                onClick={handleSavePdf}
                className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/45 bg-emerald-500/20 px-3.5 py-2 text-xs font-extrabold text-emerald-200"
              >
                {savedRecord?.status === "downloading" ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : savedRecord?.status === "paused" ? (
                  <>
                    <Download className="h-3.5 w-3.5" />
                    <span>Resume ({savedRecord.progressPct}%)</span>
                  </>
                ) : savedRecord?.status === "completed" ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Saved Offline</span>
                  </>
                ) : (
                  <>
                    <Download className="h-3.5 w-3.5" />
                    <span>Save Offline</span>
                  </>
                )}
              </button>

              {streamSrc && (
                <button
                  type="button"
                  onClick={() => setUseIframeFallback((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-3 py-2 text-xs font-extrabold text-cyan-200"
                  title="Simple browser view"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">
                    {useIframeFallback ? "Smart View" : "Browser View"}
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="flex flex-1 flex-col px-3 pt-4 sm:px-4">
        {loadingMeta ? (
          <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
            <div className="w-full max-w-sm rounded-3xl border border-rose-400/35 bg-[#0b0f29] p-7">
              <Loader2 className="mx-auto h-10 w-10 animate-spin text-rose-400" />
              <p className="mt-3.5 text-sm font-black uppercase tracking-wider text-white">
                Please wait, loading PDF...
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Sirf pehla page load hoga, baaki pages scroll par aayenge.
              </p>
            </div>
          </div>
        ) : loadError ? (
          <div className="glass-card mx-auto my-12 max-w-md rounded-3xl border border-rose-500/40 p-7 text-center">
            <FileText className="mx-auto mb-3 h-10 w-10 text-rose-400" />
            <h2 className="text-base font-black text-white">Unable to Open PDF</h2>
            <p className="mt-1.5 text-xs text-slate-300">{loadError}</p>
          </div>
        ) : !meta?.pdf?.hasRealPdf ? (
          <ComingSoonState
            accent="pink"
            badge="NOTES UPLOADING SOON"
            title="Class Notes PDF — Coming Soon!"
            subtitle="Is lecture ka PDF abhi upload ho raha hai. Telegram Sync ya Admin Panel se add hote hi yahan website ke andar khulega!"
          />
        ) : useIframeFallback ? (
          <div className="flex flex-1 flex-col overflow-hidden rounded-3xl border border-white/15 bg-[#0a0e24]">
            <iframe
              src={
                offlineBlob
                  ? URL.createObjectURL(offlineBlob)
                  : `${streamSrc}#toolbar=1&navpanes=0`
              }
              title={meta.pdf.title}
              className="min-h-[76vh] w-full flex-1 border-0 bg-white"
            />
          </div>
        ) : (
          <ProgressivePdfViewer
            url={isSameOrigin && !offlineData ? streamSrc : undefined}
            data={offlineData}
            fileName={meta.pdf.title}
            isSavedOffline={Boolean(offlineData)}
            onSaveOffline={
              meta.pdf.isTelegramChunked || isSameOrigin ? handleSavePdf : undefined
            }
            saveProgressPct={savedRecord?.progressPct}
            saveLabel={
              savedRecord?.status === "paused"
                ? `Resume ${savedRecord.progressPct}%`
                : "Save Offline"
            }
            onFallbackNeeded={() => {
              // pdf.js fail (CORS/corrupt) -> browser iframe view
              if (!offlineData && !isSameOrigin) setUseIframeFallback(true);
            }}
          />
        )}
      </main>
    </div>
  );
}
