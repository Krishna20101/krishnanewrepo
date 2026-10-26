"use client";

import React, { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Calendar,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  Play,
  PlayCircle,
  Radio,
  Star,
  Trophy,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import GlowingBackButton from "@/components/GlowingBackButton";
import SafeImage from "@/components/SafeImage";
import ComingSoonState from "@/components/ComingSoonState";
import LoginGateCard from "@/components/LoginGateCard";
import PleaseWaitScreen from "@/components/PleaseWaitScreen";
import { apiUrl } from "@/config/siteConfig";

interface NodeItemUI {
  id: string;
  parentId: string;
  title: string;
  type: "FOLDER" | "VIDEO" | "PDF" | "LINK";
  thumbnail: string;
  uploadedAt: string;
  videosCount: number;
  filesCount: number;
  hasAttachedPdf: boolean;
  hasRealPdf?: boolean;
  link?: string;
  hasSubfolders?: boolean;
  hasYoutubeEmbed?: boolean;
  hasTelegramStream?: boolean;
  important?: boolean;
}

interface BatchLevelResponse {
  ok: boolean;
  batch: {
    id: string;
    name: string;
    thumbnail: string;
    displayPrice: string;
    important?: boolean;
  };
  folderId: string | null;
  folderTitle: string;
  breadcrumbs: Array<{ id: string; title: string }>;
  folders: NodeItemUI[];
  videos: NodeItemUI[];
  pdfs: NodeItemUI[];
  links: NodeItemUI[];
  pagination?: {
    page: number;
    limit: number;
    totalFolders: number;
    totalVideos: number;
    totalPdfs: number;
    hasMore: boolean;
  };
}

function BatchExplorerInner() {
  const params = useParams<{ batchId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const {
    isHydrated,
    isLoggedIn,
    openPdfComingSoon,
    config,
    navigateWithWait,
  } = useApp();

  const batchId = decodeURIComponent(String(params.batchId || ""));
  const folderId = searchParams.get("folderId");

  const [data, setData] = useState<BatchLevelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [rootTab, setRootTab] = useState<"SUBJECTS" | "TEST" | "LIVE">(
    "SUBJECTS"
  );
  const [mediaTab, setMediaTab] = useState<"VIDEO" | "PDF">("VIDEO");

  // Reset pagination whenever batchId or folderId changes
  useEffect(() => {
    setPage(1);
  }, [batchId, folderId]);

  useEffect(() => {
    if (!isLoggedIn || !batchId) return;
    let active = true;
    if (page === 1) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }

    const qParams = new URLSearchParams();
    if (folderId) qParams.set("folderId", folderId);
    qParams.set("page", String(page));
    qParams.set("limit", "24");

    fetch(
      apiUrl(
        `/api/batches/${encodeURIComponent(batchId)}?${qParams.toString()}`
      ),
      { cache: "no-store" }
    )
      .then((r) => r.json())
      .then((res: BatchLevelResponse) => {
        if (!active) return;
        if (res?.ok) {
          setData(res);
          if (page === 1) {
            if (res.videos.length === 0 && res.pdfs.length > 0) {
              setMediaTab("PDF");
            } else {
              setMediaTab("VIDEO");
            }
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) {
          setLoading(false);
          setLoadingMore(false);
        }
      });

    return () => {
      active = false;
    };
  }, [batchId, folderId, isLoggedIn, page]);

  if (!isHydrated) {
    return <PleaseWaitScreen title="Please wait, loading..." />;
  }
  if (!isLoggedIn) return <LoginGateCard />;

  const handleStepBack = () => {
    if (!folderId) {
      router.push("/");
      return;
    }
    const crumbs = data?.breadcrumbs || [];
    if (crumbs.length >= 2) {
      const parentCrumb = crumbs[crumbs.length - 2];
      router.push(
        `/batch/${encodeURIComponent(batchId)}?folderId=${encodeURIComponent(
          parentCrumb.id
        )}`
      );
    } else {
      router.push(`/batch/${encodeURIComponent(batchId)}`);
    }
  };

  const handleOpenPdfItem = (item: NodeItemUI) => {
    if (item.hasRealPdf) {
      navigateWithWait(
        `/pdf/${encodeURIComponent(batchId)}/${encodeURIComponent(item.id)}`,
        "Please wait, opening PDF..."
      );
    } else {
      openPdfComingSoon(item.title);
    }
  };

  const isRoot = !folderId;
  const hasFolders = (data?.folders.length || 0) > 0;
  const isMediaLeaf = !isRoot && !hasFolders;

  const headerTitle = isRoot
    ? "SUBJECTS"
    : isMediaLeaf
    ? "LECTUREs & PDFs"
    : "CHAPTERS";

  const headerSubtitle = isRoot
    ? data?.batch?.name || ""
    : data?.folderTitle || "";

  const totalFoldersCount =
    data?.pagination?.totalFolders ?? data?.folders.length ?? 0;
  const totalVideosCount =
    data?.pagination?.totalVideos ?? data?.videos.length ?? 0;
  const totalPdfsCount =
    data?.pagination?.totalPdfs ?? data?.pdfs.length ?? 0;

  return (
    <div className="mx-auto min-h-screen max-w-4xl pb-16">
      {/* Top Sticky Header */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#07091b]/95 px-4 py-3.5 backdrop-blur-md">
        <div className="flex items-center gap-3.5">
          <GlowingBackButton onClick={handleStepBack} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg sm:text-xl font-black tracking-wide text-white">
              {headerTitle}
            </h1>
            {headerSubtitle && (
              <p className="truncate text-xs font-bold text-amber-300/90">
                {headerSubtitle}
              </p>
            )}
          </div>
        </div>

        {/* Clickable Breadcrumb Trail */}
        {!isRoot && data?.breadcrumbs && data.breadcrumbs.length > 0 && (
          <div className="mt-2.5 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap pb-0.5 text-[11px] font-semibold text-slate-400">
            <button
              type="button"
              onClick={() => router.push(`/batch/${encodeURIComponent(batchId)}`)}
              className="hover:text-cyan-300"
            >
              Batch
            </button>
            {data.breadcrumbs.map((b, idx) => (
              <React.Fragment key={b.id}>
                <span className="text-slate-600">›</span>
                <button
                  type="button"
                  onClick={() =>
                    router.push(
                      `/batch/${encodeURIComponent(
                        batchId
                      )}?folderId=${encodeURIComponent(b.id)}`
                    )
                  }
                  className={
                    idx === data.breadcrumbs.length - 1
                      ? "font-bold text-cyan-300"
                      : "hover:text-cyan-200"
                  }
                >
                  {b.title}
                </button>
              </React.Fragment>
            ))}
          </div>
        )}
      </header>

      <main className="px-4 pt-5">
        {/* ROOT TABS: SUBJECTS | TEST | LIVE */}
        {isRoot && (
          <div className="glass-card mb-6 grid grid-cols-3 gap-2 rounded-2xl border border-white/10 p-2">
            <button
              type="button"
              onClick={() => setRootTab("SUBJECTS")}
              className={`rounded-xl py-2.5 text-xs font-black uppercase tracking-widest transition-all ${
                rootTab === "SUBJECTS"
                  ? "border border-indigo-400/60 bg-gradient-to-r from-indigo-600 to-purple-600 text-white"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              SUBJECTS
            </button>
            <button
              type="button"
              onClick={() => setRootTab("TEST")}
              className={`flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-black uppercase tracking-widest transition-all ${
                rootTab === "TEST"
                  ? "border border-cyan-400/60 bg-gradient-to-r from-cyan-600 to-blue-600 text-white"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              <Trophy className="h-3.5 w-3.5" />
              <span>TEST</span>
            </button>
            <button
              type="button"
              onClick={() => setRootTab("LIVE")}
              className={`flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-black uppercase tracking-widest transition-all ${
                rootTab === "LIVE"
                  ? "border border-rose-400/60 bg-gradient-to-r from-rose-600 to-pink-600 text-white"
                  : "text-slate-300 hover:bg-white/5"
              }`}
            >
              <Radio className="h-3.5 w-3.5" />
              <span>LIVE</span>
            </button>
          </div>
        )}

        {isRoot && rootTab === "TEST" && (
          <ComingSoonState
            accent="cyan"
            badge="IN PROGRESS • COMING SOON"
            title="Online Test Series — Coming Soon!"
            subtitle="Chapter-wise MCQ Tests, Live Leaderboard aur Instant Score Analysis jaldi hi yahan live hoga!"
          />
        )}

        {isRoot && rootTab === "LIVE" && (
          <ComingSoonState
            accent="pink"
            badge="IN PROGRESS • COMING SOON"
            title="Live Interactive Classes — Coming Soon!"
            subtitle="Real-time Live Stream aur Live Doubt Chat abhi setup ho raha hai. Recorded lectures SUBJECTS tab me dekhein!"
          />
        )}

        {/* CLEAR LOADING INDICATOR */}
        {loading && (!isRoot || rootTab === "SUBJECTS") && (
          <PleaseWaitScreen
            title="Please wait, loading folder..."
            subtitle="Is folder ke subjects aur lectures load ho rahe hain..."
          />
        )}

        {/* CONTENT EXPLORER */}
        {!loading && data && (!isRoot || rootTab === "SUBJECTS") && (
          <div>
            {isRoot && totalFoldersCount > 0 && (
              <p className="mb-3.5 text-xs font-extrabold uppercase tracking-widest text-slate-300">
                TOTAL SUBJECTS:{" "}
                <span className="text-cyan-300">{totalFoldersCount}</span>
              </p>
            )}

            {/* 1. SUBFOLDERS / SUBJECTS / CHAPTERS LIST */}
            {data.folders.length > 0 && (
              <div className="space-y-3.5">
                {data.folders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() =>
                      router.push(
                        `/batch/${encodeURIComponent(
                          batchId
                        )}?folderId=${encodeURIComponent(folder.id)}`
                      )
                    }
                    className={`glass-card glass-card-hover perf-card-item flex w-full items-center gap-4 rounded-3xl border p-3.5 text-left ${
                      folder.important
                        ? "border-amber-400/55 shadow-[0_0_22px_rgba(251,191,36,0.14)]"
                        : "border-white/10"
                    }`}
                  >
                    <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-cyan-400/30 bg-[#0d1230] p-0.5">
                      <SafeImage
                        src={folder.thumbnail}
                        fallbackSrc={config.defaultImageUrl}
                        alt={folder.title}
                        className="h-full w-full rounded-[14px] object-cover"
                      />
                      {folder.important && (
                        <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-slate-950 shadow">
                          <Star className="h-3 w-3 fill-slate-950" />
                        </span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {folder.important && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/20 border border-amber-400/50 px-2 py-0.5 text-[10px] font-black uppercase text-amber-300">
                            <Star className="h-2.5 w-2.5 fill-amber-300 text-amber-300" />
                            <span>IMPORTANT</span>
                          </span>
                        )}
                        <h3 className="truncate text-base sm:text-lg font-extrabold text-white">
                          {folder.title}
                        </h3>
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs font-bold">
                        {isRoot && folder.hasSubfolders ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-400">
                            <Play className="h-3.5 w-3.5 fill-cyan-400 text-cyan-400" />
                            <span>CHAPTERS</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-rose-400">
                            <Play className="h-3.5 w-3.5 fill-cyan-400 text-cyan-400" />
                            <span>Lectures aur PDF dekho</span>
                          </span>
                        )}

                        {(folder.videosCount > 0 || folder.filesCount > 0) && (
                          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[10px] text-slate-300">
                            {folder.videosCount > 0
                              ? `${folder.videosCount} Videos`
                              : ""}
                            {folder.videosCount > 0 && folder.filesCount > 0
                              ? " • "
                              : ""}
                            {folder.filesCount > 0
                              ? `${folder.filesCount} PDFs`
                              : ""}
                          </span>
                        )}
                      </div>
                    </div>

                    <FolderOpen className="mr-1 h-5 w-5 shrink-0 text-cyan-300/70" />
                  </button>
                ))}
              </div>
            )}

            {/* 2. LEAF MEDIA VIEW (VIDEO | PDF Toggle Tabs) */}
            {(totalVideosCount > 0 || totalPdfsCount > 0) && (
              <div className={data.folders.length > 0 ? "mt-8" : ""}>
                <div className="glass-card mb-5 grid grid-cols-2 gap-2 rounded-2xl border border-white/10 p-2">
                  <button
                    type="button"
                    onClick={() => setMediaTab("VIDEO")}
                    className={`flex items-center justify-center gap-2 rounded-xl py-3 text-xs font-black uppercase tracking-widest transition-all ${
                      mediaTab === "VIDEO"
                        ? "border border-indigo-400/60 bg-gradient-to-r from-indigo-600 to-purple-600 text-white"
                        : "text-slate-300 hover:bg-white/5"
                    }`}
                  >
                    <PlayCircle className="h-4 w-4" />
                    <span>VIDEO ({totalVideosCount})</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setMediaTab("PDF")}
                    className={`flex items-center justify-center gap-2 rounded-xl py-3 text-xs font-black uppercase tracking-widest transition-all ${
                      mediaTab === "PDF"
                        ? "border border-rose-400/60 bg-gradient-to-r from-rose-600 to-pink-600 text-white"
                        : "text-slate-300 hover:bg-white/5"
                    }`}
                  >
                    <FileText className="h-4 w-4" />
                    <span>PDF ({totalPdfsCount})</span>
                  </button>
                </div>

                {/* VIDEO LECTURES LIST */}
                {mediaTab === "VIDEO" && (
                  <>
                    {data.videos.length === 0 ? (
                      <div className="glass-card rounded-3xl border border-white/10 p-8 text-center text-sm font-semibold text-slate-400">
                        Is folder me abhi koi video lecture nahi hai. PDF tab check
                        karein!
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                        {data.videos.map((video) => (
                          <div
                            key={video.id}
                            className={`glass-card glass-card-hover perf-card-item flex flex-col overflow-hidden rounded-3xl border p-3.5 ${
                              video.important
                                ? "border-amber-400/55"
                                : "border-white/10"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                navigateWithWait(
                                  `/watch/${encodeURIComponent(
                                    batchId
                                  )}/${encodeURIComponent(video.id)}`,
                                  "Please wait, loading lecture..."
                                )
                              }
                              className="group relative aspect-[16/9] w-full overflow-hidden rounded-2xl bg-[#0b0f26] text-left"
                            >
                              <SafeImage
                                src={video.thumbnail}
                                fallbackSrc={config.defaultImageUrl}
                                alt={video.title}
                                className="h-full w-full object-cover"
                              />
                              {video.important && (
                                <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-amber-400 px-2.5 py-0.5 text-[10px] font-black text-slate-950">
                                  <Star className="h-3 w-3 fill-slate-950" />
                                  IMPORTANT
                                </span>
                              )}
                              <div className="absolute inset-0 flex items-center justify-center bg-black/25">
                                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-cyan-400/90 text-slate-950 shadow-glow-cyan">
                                  <Play className="h-5 w-5 translate-x-0.5 fill-slate-950" />
                                </div>
                              </div>
                            </button>

                            <h4 className="mt-3.5 line-clamp-2 text-base font-extrabold text-white">
                              {video.title}
                            </h4>

                            {video.uploadedAt && (
                              <div className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-slate-300">
                                <Calendar className="h-3.5 w-3.5 text-cyan-300" />
                                <span>Upload: {video.uploadedAt}</span>
                              </div>
                            )}

                            <div className="mt-4 space-y-2.5">
                              <button
                                type="button"
                                onClick={() =>
                                  navigateWithWait(
                                    `/watch/${encodeURIComponent(
                                      batchId
                                    )}/${encodeURIComponent(video.id)}`,
                                    "Please wait, loading lecture..."
                                  )
                                }
                                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-600 via-blue-600 to-purple-600 py-3 text-xs font-black uppercase tracking-widest text-white transition hover:brightness-110 active:scale-[0.98]"
                              >
                                <Play className="h-4 w-4 fill-white" />
                                <span>PLAY</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => handleOpenPdfItem(video)}
                                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-rose-500/45 bg-gradient-to-r from-rose-600/90 to-pink-600/90 py-3 text-xs font-black uppercase tracking-widest text-white transition hover:brightness-110 active:scale-[0.98]"
                              >
                                <FileText className="h-4 w-4" />
                                <span>
                                  {video.hasRealPdf ? "OPEN PDF NOTES" : "PDF"}
                                </span>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* PDF NOTES LIST */}
                {mediaTab === "PDF" && (
                  <>
                    {data.pdfs.length === 0 ? (
                      <div className="glass-card rounded-3xl border border-white/10 p-8 text-center text-sm font-semibold text-slate-400">
                        Is chapter me abhi koi PDF note nahi hai.
                      </div>
                    ) : (
                      <div className="space-y-3.5">
                        {data.pdfs.map((pdf) => (
                          <div
                            key={`pdf_${pdf.id}`}
                            className="glass-card glass-card-hover perf-card-item rounded-3xl border border-white/10 p-4"
                          >
                            <div className="flex items-start gap-3.5">
                              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-rose-400/40 bg-gradient-to-br from-rose-600 to-pink-700 text-white">
                                <FileText className="h-6 w-6" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <h4 className="text-base font-extrabold text-white">
                                  {pdf.title}
                                </h4>
                                {pdf.uploadedAt && (
                                  <p className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
                                    <Calendar className="h-3.5 w-3.5 text-rose-300" />
                                    <span>{pdf.uploadedAt}</span>
                                  </p>
                                )}
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => handleOpenPdfItem(pdf)}
                              className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-rose-600 via-red-600 to-pink-600 py-3 text-xs font-black uppercase tracking-widest text-white transition hover:brightness-110 active:scale-[0.98]"
                            >
                              <FileText className="h-4 w-4" />
                              <span>
                                {pdf.hasRealPdf ? "VIEW PDF IN WEBSITE" : "PDF"}
                              </span>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* PAGINATION "LOAD MORE" BUTTON FOR LARGE FOLDERS */}
            {data.pagination?.hasMore && (
              <div className="mt-7 text-center">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => setPage((p) => p + 1)}
                  className="inline-flex items-center gap-2 rounded-2xl border border-cyan-400/45 bg-cyan-500/15 px-7 py-3.5 text-xs font-black uppercase tracking-widest text-cyan-200 transition hover:bg-cyan-500/25 disabled:opacity-60"
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Please wait, loading more...</span>
                    </>
                  ) : (
                    <span>Load More Items</span>
                  )}
                </button>
              </div>
            )}

            {/* 3. DIRECT EXTERNAL LINKS */}
            {data.links.length > 0 && (
              <div className="mt-6 space-y-3">
                {data.links.map((lnk) => (
                  <a
                    key={lnk.id}
                    href={lnk.link || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="glass-card glass-card-hover flex items-center justify-between gap-4 rounded-3xl border border-emerald-400/30 p-3.5"
                  >
                    <div className="flex items-center gap-3.5">
                      <div className="h-12 w-12 overflow-hidden rounded-2xl border border-emerald-400/40 bg-[#0d1f1a]">
                        <SafeImage
                          src={lnk.thumbnail}
                          fallbackSrc={config.defaultImageUrl}
                          alt={lnk.title}
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <div>
                        <h4 className="text-sm font-extrabold text-white">
                          {lnk.title}
                        </h4>
                        <p className="text-xs font-semibold text-emerald-300">
                          Tap to Open Channel / Group
                        </p>
                      </div>
                    </div>
                    <ExternalLink className="mr-2 h-5 w-5 text-emerald-300" />
                  </a>
                ))}
              </div>
            )}

            {/* Empty Folder State */}
            {data.folders.length === 0 &&
              data.videos.length === 0 &&
              data.pdfs.length === 0 &&
              data.links.length === 0 && (
                <ComingSoonState
                  accent="cyan"
                  badge="UPLOADING SOON"
                  title="Lectures Uploading Soon!"
                  subtitle="Is batch ke folders aur lectures jald hi update kiye jayenge."
                />
              )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function BatchExplorerPage() {
  return (
    <Suspense
      fallback={
        <PleaseWaitScreen
          title="Please wait, loading folder..."
          subtitle="Course data open ho raha hai..."
        />
      }
    >
      <BatchExplorerInner />
    </Suspense>
  );
}
