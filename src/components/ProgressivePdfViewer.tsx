"use client";

// ============================================================================
// 📄 PROGRESSIVE PDF VIEWER — "Pehle upar ka page, phir scroll par neeche"
// ============================================================================
// Purana tarika: poori PDF (kabhi 80-200 MB) ek saath download karke RAM me
// Blob banata tha -> low-RAM phone par PDF "kahi kahi khulti hi nahi thi".
//
// Naya tarika (pdf.js Range Requests):
//   • PDF ka sirf UTNA byte hi aata hai jitna dikhne wale page ke liye chahiye
//     (`disableAutoFetch: true` + 512 KB range chunks). Pehla page ~200-500 KB
//     me khul jata hai, baaki pages scroll karne par apne aap aate hain.
//   • Pages IntersectionObserver se render hote hain (top-first), aur door ke
//     pages ka canvas RAM se free kar diya jata hai -> phone garam nahi hota.
//   • Offline vault me PDF saved hai to 0 internet, 0 second me khulti hai.
//   • Zoom, page-jump, aur saaf "Please wait, loading page N..." indicators.
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RefreshCw,
  ZoomIn,
} from "lucide-react";

type PdfJsModule = typeof import("pdfjs-dist");
interface PdfDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy?: () => Promise<void> | void;
}
interface PdfPage {
  getViewport: (p: { scale: number }) => { width: number; height: number };
  render: (p: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
    transform?: number[];
  }) => { promise: Promise<void> };
  cleanup?: () => void;
}

export interface ProgressivePdfViewerProps {
  /** Range-request capable URL (Cloudflare Worker ya /api/tg/stream/...) */
  url?: string;
  /** Offline vault / pre-downloaded bytes (priority over url) */
  data?: ArrayBuffer | null;
  fileName?: string;
  /** Vault me offline save karne ka action (parent page deta hai) */
  onSaveOffline?: () => void;
  saveLabel?: string;
  saveProgressPct?: number;
  isSavedOffline?: boolean;
  onFallbackNeeded?: () => void;
}

const MAX_LIVE_CANVASES = 8; // low-RAM phones: ek saath max 8 page canvas
const RENDER_AHEAD_PX = "900px";

export default function ProgressivePdfViewer({
  url,
  data,
  fileName = "Class Notes",
  onSaveOffline,
  saveLabel = "Save Offline",
  saveProgressPct,
  isSavedOffline,
  onFallbackNeeded,
}: ProgressivePdfViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const slotsRef = useRef<Array<HTMLDivElement | null>>([]);
  const canvasRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const renderedRef = useRef<Map<number, boolean>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pdfRef = useRef<PdfDoc | null>(null);
  const pdfjsRef = useRef<PdfJsModule | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [loadingDoc, setLoadingDoc] = useState(true);
  const [loadPct, setLoadPct] = useState(0);
  const [fatalError, setFatalError] = useState("");
  const [scale, setScale] = useState(1.15);
  const [currentPage, setCurrentPage] = useState(1);
  const [renderingPages, setRenderingPages] = useState<Set<number>>(new Set());
  const [pageRatio, setPageRatio] = useState(1.414); // A4 default
  const [isFullscreen, setIsFullscreen] = useState(false);

  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  // --------------------------------------------------------- load document
  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      setLoadingDoc(true);
      setFatalError("");
      setLoadPct(0);
      try {
        const pdfjs = (await import("pdfjs-dist")) as PdfJsModule;
        // Worker public/ me hai (CDN/internet ki zaroorat nahi)
        (pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } })
          .GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
        pdfjsRef.current = pdfjs;

        const params: Record<string, unknown> = data
          ? { data }
          : {
              url,
              httpHeaders: { "X-SHD-Client": "pdf-viewer" },
              withCredentials: false,
              // 🔑 Progressive magic: sirf zaroorat ke bytes lao
              rangeChunkSize: 512 * 1024,
              disableAutoFetch: true,
              disableStream: false,
            };

        const task = (
          pdfjs as unknown as {
            getDocument: (p: Record<string, unknown>) => {
              promise: Promise<PdfDoc>;
              onProgress?: (p: { loaded: number; total: number }) => void;
              destroy?: () => void;
            };
          }
        ).getDocument(params);

        task.onProgress = ({ loaded, total }) => {
          if (cancelled) return;
          if (total > 0) setLoadPct(Math.min(99, Math.round((loaded / total) * 100)));
          else setLoadPct((p) => Math.min(95, p + 5));
        };

        const doc = await task.promise;
        if (cancelled) return;
        pdfRef.current = doc;
        setNumPages(doc.numPages);
        setLoadingDoc(false);
        setLoadPct(100);

        // Pehle page ka size se placeholder height fix karo (turant layout ready)
        try {
          const p1 = (await doc.getPage(1)) as PdfPage;
          const vp = p1.getViewport({ scale: 1 });
          if (vp.height > 0) setPageRatio(vp.height / vp.width);
          p1.cleanup?.();
        } catch {
          // ignore
        }
      } catch (err) {
        if (cancelled) return;
        setLoadingDoc(false);
        const msg = err instanceof Error ? err.message : String(err);
        setFatalError(
          `PDF load nahi ho paya (${msg.slice(0, 90)}). Retry dabayein ya offline save karke kholein.`
        );
        onFallbackNeeded?.();
      }
    };

    void boot();

    return () => {
      cancelled = true;
      try {
        observerRef.current?.disconnect();
      } catch {
        // ignore
      }
      renderedRef.current.clear();
      canvasRef.current.clear();
      const doc = pdfRef.current;
      pdfRef.current = null;
      if (doc?.destroy) {
        try {
          void doc.destroy();
        } catch {
          // ignore
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, data]);

  // --------------------------------------------------------- render one page
  const renderPage = useCallback(
    async (pageNum: number) => {
      const doc = pdfRef.current;
      const slot = slotsRef.current[pageNum - 1];
      if (!doc || !slot || renderedRef.current.get(pageNum)) return;

      renderedRef.current.set(pageNum, true);
      setRenderingPages((prev) => new Set(prev).add(pageNum));

      try {
        const page = (await doc.getPage(pageNum)) as PdfPage;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const useScale = scaleRef.current;
        const viewport = page.getViewport({ scale: useScale });

        let canvas = canvasRef.current.get(pageNum);
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.className = "mx-auto block w-full rounded-lg bg-white shadow-lg";
          slot.innerHTML = "";
          slot.appendChild(canvas);
          canvasRef.current.set(pageNum, canvas);
        }

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        slot.style.aspectRatio = "";
        slot.style.height = "auto";

        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("canvas 2d unavailable");

        await page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;

        page.cleanup?.();
        freeFarCanvases(pageNum);
      } catch {
        renderedRef.current.set(pageNum, false);
        const slotEl = slotsRef.current[pageNum - 1];
        if (slotEl) {
          slotEl.innerHTML = `<div class="flex h-full items-center justify-center rounded-lg border border-rose-400/30 bg-rose-500/10 p-4 text-[11px] font-bold text-rose-200">Page ${pageNum} render nahi hua — scroll karke dubara try karein</div>`;
        }
      } finally {
        setRenderingPages((prev) => {
          const next = new Set(prev);
          next.delete(pageNum);
          return next;
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /** RAM bachao: current page se door ke canvas free kar do */
  const freeFarCanvases = useCallback((centerPage: number) => {
    if (canvasRef.current.size <= MAX_LIVE_CANVASES) return;
    const pages = Array.from(canvasRef.current.keys()).sort(
      (a, b) => Math.abs(a - centerPage) - Math.abs(b - centerPage)
    );
    const toFree = pages.slice(MAX_LIVE_CANVASES);
    for (const p of toFree) {
      const c = canvasRef.current.get(p);
      if (c) {
        c.width = 0;
        c.height = 0;
        c.remove();
      }
      canvasRef.current.delete(p);
      renderedRef.current.set(p, false);
      const slot = slotsRef.current[p - 1];
      if (slot) {
        slot.innerHTML = "";
        slot.style.aspectRatio = `1 / ${pageRatio}`;
      }
    }
  }, [pageRatio]);

  // ------------------------------------------------- IntersectionObserver lazy
  useEffect(() => {
    if (loadingDoc || numPages === 0) return;

    try {
      observerRef.current?.disconnect();
    } catch {
      // ignore
    }

    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = Number((entry.target as HTMLElement).dataset.page || "0");
          if (!idx) continue;
          setCurrentPage(idx);
          void renderPage(idx);
        }
      },
      { root: null, rootMargin: RENDER_AHEAD_PX, threshold: 0.01 }
    );
    observerRef.current = obs;

    for (let i = 1; i <= numPages; i++) {
      const slot = slotsRef.current[i - 1];
      if (slot) obs.observe(slot);
    }

    // Top-first: pehle 2 pages turant render (user ko instant content dikhe)
    void renderPage(1);
    if (numPages > 1) void renderPage(2);

    return () => {
      try {
        obs.disconnect();
      } catch {
        // ignore
      }
    };
  }, [loadingDoc, numPages, renderPage]);

  // ------------------------------------------------------------- zoom change
  useEffect(() => {
    if (loadingDoc || numPages === 0) return;
    // Zoom badla -> sab pages dubara render (sirf visible + aage ke)
    renderedRef.current.clear();
    for (const [, c] of Array.from(canvasRef.current.entries())) {
      c.width = 0;
      c.height = 0;
      c.remove();
    }
    canvasRef.current.clear();
    for (let i = 1; i <= numPages; i++) {
      const slot = slotsRef.current[i - 1];
      if (slot) {
        slot.innerHTML = "";
        slot.style.aspectRatio = `1 / ${pageRatio}`;
      }
    }
    const start = Math.max(1, currentPage - 1);
    for (let i = start; i < Math.min(numPages, start + 2); i++) {
      void renderPage(i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  const goToPage = useCallback((n: number) => {
    const slot = slotsRef.current[Math.min(Math.max(1, n), numPages) - 1];
    slot?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [numPages]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await containerRef.current?.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      // ignore
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full min-h-[60vh] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#070a18]"
    >
      {/* Toolbar */}
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#0a0f24]/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2 text-[11px] font-bold text-slate-300">
          <span className="max-w-[42vw] truncate text-cyan-300 sm:max-w-xs">
            {fileName}
          </span>
          {numPages > 0 && (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px]">
              Page {currentPage} / {numPages}
            </span>
          )}
          {isSavedOffline && (
            <span className="rounded-full border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[9px] font-black uppercase text-emerald-300">
              Offline
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            className="rounded-lg border border-white/15 bg-white/5 p-1.5 text-slate-200 disabled:opacity-40"
            title="Previous page"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= numPages}
            className="rounded-lg border border-white/15 bg-white/5 p-1.5 text-slate-200 disabled:opacity-40"
            title="Next page"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>

          <div className="mx-1 h-5 w-px bg-white/15" />

          <button
            type="button"
            onClick={() => setScale((s) => Math.max(0.6, Number((s - 0.2).toFixed(2))))}
            className="rounded-lg border border-white/15 bg-white/5 p-1.5 text-slate-200"
            title="Zoom out"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="w-10 text-center text-[10px] font-black text-cyan-300">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(3, Number((s + 0.2).toFixed(2))))}
            className="rounded-lg border border-white/15 bg-white/5 p-1.5 text-slate-200"
            title="Zoom in"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setScale(1.15)}
            className="rounded-lg border border-white/15 bg-white/5 p-1.5 text-slate-200"
            title="Fit width"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>

          <div className="mx-1 h-5 w-px bg-white/15" />

          {onSaveOffline && (
            <button
              type="button"
              onClick={onSaveOffline}
              disabled={typeof saveProgressPct === "number" && saveProgressPct > 0 && saveProgressPct < 100}
              className="rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-2.5 py-1.5 text-[10px] font-black text-emerald-200 disabled:opacity-60"
            >
              {typeof saveProgressPct === "number" && saveProgressPct > 0 && saveProgressPct < 100
                ? `Saving ${saveProgressPct}%`
                : isSavedOffline
                ? "Saved ✓"
                : saveLabel}
            </button>
          )}

          <button
            type="button"
            onClick={toggleFullscreen}
            className="rounded-lg border border-white/15 bg-white/5 p-1.5 text-slate-200"
            title="Fullscreen"
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Loading / Error states */}
      {loadingDoc && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <Loader2 className="h-9 w-9 animate-spin text-cyan-300" />
          <p className="text-xs font-black uppercase tracking-widest text-cyan-300">
            Please wait, PDF ka pehla page load ho raha hai...
          </p>
          {loadPct > 0 && (
            <div className="h-1.5 w-52 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-purple-500 transition-all"
                style={{ width: `${loadPct}%` }}
              />
            </div>
          )}
        </div>
      )}

      {fatalError && !loadingDoc && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-md text-xs font-bold text-rose-300">{fatalError}</p>
          <button
            type="button"
            onClick={() => {
              setFatalError("");
              setLoadingDoc(true);
              setNumPages(0);
              renderedRef.current.clear();
              // url/data change na ho to bhi dobara boot karne ke liye reload
              window.location.reload();
            }}
            className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-xs font-black uppercase text-slate-950"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry PDF
          </button>
        </div>
      )}

      {/* Page slots */}
      {!loadingDoc && !fatalError && numPages > 0 && (
        <div className="flex-1 space-y-3 overflow-y-auto bg-[#05070f] p-3">
          {Array.from({ length: numPages }).map((_, i) => {
            const pageNum = i + 1;
            const isRendering = renderingPages.has(pageNum);
            return (
              <div
                key={pageNum}
                data-page={pageNum}
                ref={(el) => {
                  slotsRef.current[i] = el;
                }}
                className="relative mx-auto w-full max-w-3xl overflow-hidden rounded-lg"
                style={{ aspectRatio: `1 / ${pageRatio}` }}
              >
                {isRendering && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[#0b1024]/85">
                    <Loader2 className="h-6 w-6 animate-spin text-cyan-300" />
                    <span className="text-[10px] font-bold text-cyan-200">
                      Please wait, page {pageNum} load ho raha hai...
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
