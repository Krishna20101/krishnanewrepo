"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  ExternalLink,
  FileText,
  Loader2,
  Play,
  Sparkles,
} from "lucide-react";
import { useApp } from "@/context/AppContext";
import SafeImage from "@/components/SafeImage";
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

type MediaTab = "VIDEO" | "PDF";

function BatchExplorerInner() {
  const params = useParams<{ batchId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isHydrated, isLoggedIn, openPdfComingSoon, config, navigateWithWait } =
    useApp();

  const batchId = decodeURIComponent(String(params.batchId || ""));
  const folderId = searchParams.get("folderId");

  const [data, setData] = useState<BatchLevelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [mediaTab, setMediaTab] = useState<MediaTab>("VIDEO");

  useEffect(() => {
    setPage(1);
  }, [batchId, folderId]);

  useEffect(() => {
    if (!isLoggedIn || !batchId) return;
    let active = true;
    if (page === 1) setLoading(true);
    else setLoadingMore(true);

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
            setMediaTab(res.videos.length === 0 && res.pdfs.length > 0 ? "PDF" : "VIDEO");
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

  if (!isHydrated) return <PleaseWaitScreen title="Please wait, loading..." />;
  if (!isLoggedIn) return <LoginGateCard />;

  const handleStepBack = () => {
    if (!folderId) {
      router.push("/");
      return;
    }
    const crumbs = data?.breadcrumbs || [];
    if (crumbs.length >= 2) {
      const parent = crumbs[crumbs.length - 2];
      router.push(
        `/batch/${encodeURIComponent(batchId)}?folderId=${encodeURIComponent(
          parent.id
        )}`
      );
    } else {
      router.push(`/batch/${encodeURIComponent(batchId)}`);
    }
  };

  const openPdf = (item: NodeItemUI) => {
    if (item.hasRealPdf) {
      navigateWithWait(
        `/pdf/${encodeURIComponent(batchId)}/${encodeURIComponent(item.id)}`,
        "Opening notes..."
      );
    } else {
      openPdfComingSoon(item.title);
    }
  };

  const isRoot = !folderId;
  const hasFolders = (data?.folders.length || 0) > 0;
  const isMediaLeaf = !isRoot && !hasFolders;

  const totalVideosCount =
    data?.pagination?.totalVideos ?? data?.videos.length ?? 0;
  const totalPdfsCount =
    data?.pagination?.totalPdfs ?? data?.pdfs.length ?? 0;

  const screenTitle = isRoot
    ? data?.batch?.name || "Course"
    : data?.folderTitle || "Chapter";
  const screenKicker = isRoot
    ? "Course contents"
    : isMediaLeaf
    ? "Chapter material"
    : "Inside chapter";

  return (
    <div className="mx-auto min-h-screen w-full max-w-4xl">
      {/* ───────────── Top bar ───────────── */}
      <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#08090f]/92 backdrop-blur-sm">
        <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={handleStepBack}
            aria-label="Go back"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] text-sand-200 transition hover:border-ember-500/45 hover:text-ember-300"
          >
            <ArrowLeft className="h-[18px] w-[18px]" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-ember-400">
              {screenKicker}
            </p>
            <h1 className="truncate font-display text-[16px] font-semibold leading-tight text-sand-100">
              {screenTitle}
            </h1>
          </div>
        </div>

        {/* breadcrumbs — plain text trail, no pills */}
        {!isRoot && data?.breadcrumbs && data.breadcrumbs.length > 0 && (
          <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap px-4 pb-2.5 text-[11px] font-medium text-sand-500 sm:px-6">
            <button
              type="button"
              onClick={() => router.push(`/batch/${encodeURIComponent(batchId)}`)}
              className="shrink-0 hover:text-ember-300"
            >
              Course
            </button>
            {data.breadcrumbs.map((b, idx) => (
              <React.Fragment key={b.id}>
                <ChevronRight className="h-3 w-3 shrink-0 text-sand-500/60" />
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
                      ? "shrink-0 font-semibold text-sand-200"
                      : "shrink-0 hover:text-ember-300"
                  }
                >
                  {b.title}
                </button>
              </React.Fragment>
            ))}
          </div>
        )}
      </header>

      <main className="px-4 pb-16 pt-5 sm:px-6">
        {loading ? (
          <PleaseWaitScreen title="Loading contents..." />
        ) : !data ? (
          <div className="surface rounded-card px-6 py-14 text-center">
            <p className="font-display text-lg font-semibold text-sand-100">
              Could not load this course
            </p>
            <p className="mt-1.5 text-[13px] text-sand-400">
              Please go back and try again.
            </p>
          </div>
        ) : (
          <>
            {/* ───────────── Subjects / chapters (list, editorial rows) ───────── */}
            {data.folders.length > 0 && (
              <section aria-label="Subjects">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-sand-400">
                    {isRoot ? "Subjects" : "Chapters"}
                  </h2>
                  <span className="text-[11px] font-semibold text-sand-500">
                    {data.pagination?.totalFolders ?? data.folders.length}
                  </span>
                </div>

                <div className="divide-y divide-white/[0.06] overflow-hidden rounded-card border border-white/[0.08] bg-ink-900/55">
                  {data.folders.map((folder, idx) => (
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
                      className="group flex w-full items-center gap-3.5 px-3.5 py-3.5 text-left transition-colors hover:bg-white/[0.035]"
                    >
                      {/* index / thumb */}
                      <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-ink-850">
                        {folder.thumbnail ? (
                          <SafeImage
                            src={folder.thumbnail}
                            fallbackSrc={config.defaultImageUrl}
                            alt={folder.title}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center font-display text-[15px] font-semibold text-sand-400">
                            {String(idx + 1).padStart(2, "0")}
                          </span>
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="truncate text-[14.5px] font-semibold text-sand-100 group-hover:text-ember-300">
                            {folder.title}
                          </h3>
                          {folder.important && (
                            <span className="shrink-0 rounded-tag border border-ember-400/45 px-1.5 py-[1px] text-[9px] font-extrabold uppercase tracking-wider text-ember-300">
                              Key
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[11px] font-medium text-sand-500">
                          {folder.hasSubfolders ? (
                            <span className="text-sand-400">Folder</span>
                          ) : (
                            <span>Lectures &amp; notes</span>
                          )}
                          {folder.videosCount > 0 && (
                            <span>{folder.videosCount} lectures</span>
                          )}
                          {folder.filesCount > 0 && (
                            <span className="text-sage-400">
                              {folder.filesCount} notes
                            </span>
                          )}
                        </p>
                      </div>

                      <ChevronRight className="h-4 w-4 shrink-0 text-sand-500 transition-transform group-hover:translate-x-0.5 group-hover:text-ember-400" />
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* ───────────── Media: VIDEO | PDF (segmented, no LIVE) ───────── */}
            {(totalVideosCount > 0 || totalPdfsCount > 0) && (
              <section className={data.folders.length > 0 ? "mt-8" : ""}>
                {/* Segmented switch — flat rail, sliding ember underline */}
                <div className="relative mb-5 flex items-center gap-1 border-b border-white/[0.08]">
                  {(
                    [
                      {
                        key: "VIDEO" as MediaTab,
                        label: "Lectures",
                        count: totalVideosCount,
                      },
                      {
                        key: "PDF" as MediaTab,
                        label: "Notes",
                        count: totalPdfsCount,
                      },
                    ] as const
                  ).map((t) => {
                    const active = mediaTab === t.key;
                    return (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setMediaTab(t.key)}
                        className={`relative -mb-px inline-flex items-center gap-1.5 px-4 py-2.5 text-[12px] font-bold uppercase tracking-[0.12em] transition-colors ${
                          active
                            ? "text-ember-300"
                            : "text-sand-500 hover:text-sand-200"
                        }`}
                      >
                        {t.key === "VIDEO" ? (
                          <Play className="h-3.5 w-3.5" />
                        ) : (
                          <FileText className="h-3.5 w-3.5" />
                        )}
                        <span>{t.label}</span>
                        <span
                          className={`rounded px-1.5 py-px text-[10px] font-extrabold ${
                            active
                              ? "bg-ember-500/20 text-ember-300"
                              : "bg-white/[0.06] text-sand-500"
                          }`}
                        >
                          {t.count}
                        </span>
                        {active && (
                          <span className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-ember-500" />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* ── VIDEO: wide horizontal rows with left-aligned play ── */}
                {mediaTab === "VIDEO" && (
                  <>
                    {data.videos.length === 0 ? (
                      <EmptyNote text="No lectures in this chapter yet." />
                    ) : (
                      <div className="space-y-2.5">
                        {data.videos.map((video, i) => (
                          <button
                            key={video.id}
                            type="button"
                            onClick={() =>
                              navigateWithWait(
                                `/watch/${encodeURIComponent(
                                  batchId
                                )}/${encodeURIComponent(video.id)}`,
                                "Opening lecture..."
                              )
                            }
                            className="surface group flex w-full items-center gap-3.5 rounded-xl p-2.5 text-left transition-colors hover:border-ember-500/40"
                          >
                            <div className="relative h-[54px] w-24 shrink-0 overflow-hidden rounded-lg bg-ink-850">
                              <SafeImage
                                src={video.thumbnail}
                                fallbackSrc={config.defaultImageUrl}
                                alt={video.title}
                                className="h-full w-full object-cover"
                              />
                              <span className="absolute inset-0 flex items-center justify-center bg-ink-950/40 transition-colors group-hover:bg-ink-950/20">
                                <Play className="h-4 w-4 fill-sand-100 text-sand-100" />
                              </span>
                              <span className="absolute bottom-1 left-1 rounded bg-ink-950/85 px-1 text-[9px] font-bold text-sand-300">
                                {String(i + 1).padStart(2, "0")}
                              </span>
                            </div>

                            <div className="min-w-0 flex-1">
                              <h4 className="line-clamp-2 text-[13.5px] font-semibold leading-snug text-sand-100 group-hover:text-ember-300">
                                {video.title}
                              </h4>
                              <p className="mt-1 flex flex-wrap items-center gap-x-2.5 text-[10.5px] font-medium text-sand-500">
                                {video.uploadedAt && <span>{video.uploadedAt}</span>}
                                {video.hasAttachedPdf && (
                                  <span className="text-sage-400">Notes attached</span>
                                )}
                              </p>
                            </div>

                            <Play className="mr-1.5 h-4 w-4 shrink-0 text-ember-400 opacity-0 transition-opacity group-hover:opacity-100" />
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* ── PDF: document-style rows, file glyph + direct action ── */}
                {mediaTab === "PDF" && (
                  <>
                    {data.pdfs.length === 0 ? (
                      <EmptyNote text="No notes in this chapter yet." />
                    ) : (
                      <div className="overflow-hidden rounded-card border border-white/[0.08] bg-ink-900/55">
                        {data.pdfs.map((pdf, i) => (
                          <div
                            key={`pdf_${pdf.id}`}
                            className={`flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-white/[0.03] ${
                              i > 0 ? "border-t border-white/[0.06]" : ""
                            }`}
                          >
                            <div className="flex h-10 w-9 shrink-0 items-center justify-center rounded-md border border-white/12 bg-ink-850">
                              <FileText className="h-4 w-4 text-sage-400" />
                            </div>

                            <div className="min-w-0 flex-1">
                              <h4 className="line-clamp-2 text-[13.5px] font-semibold text-sand-100">
                                {pdf.title}
                              </h4>
                              <p className="mt-0.5 text-[10.5px] font-medium text-sand-500">
                                {pdf.uploadedAt || "PDF document"}
                              </p>
                            </div>

                            <button
                              type="button"
                              onClick={() => openPdf(pdf)}
                              className="btn-ghost shrink-0 px-3 py-1.5 text-[11px] uppercase tracking-[0.1em]"
                            >
                              {pdf.hasRealPdf ? "View" : "Open"}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {/* Load more */}
            {data.pagination?.hasMore && (
              <div className="mt-6 text-center">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => setPage((p) => p + 1)}
                  className="btn-ghost px-6 py-2.5 text-[11px] uppercase tracking-[0.14em] disabled:opacity-60"
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Loading</span>
                    </>
                  ) : (
                    <span>Load more</span>
                  )}
                </button>
              </div>
            )}

            {/* External links */}
            {data.links.length > 0 && (
              <section className="mt-7 space-y-2.5">
                {data.links.map((lnk) => (
                  <a
                    key={lnk.id}
                    href={lnk.link || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="surface flex items-center justify-between gap-3 rounded-xl p-3 transition-colors hover:border-sage-400/40"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-ink-850">
                        <SafeImage
                          src={lnk.thumbnail}
                          fallbackSrc={config.defaultImageUrl}
                          alt={lnk.title}
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <div className="min-w-0">
                        <h4 className="truncate text-[13px] font-semibold text-sand-100">
                          {lnk.title}
                        </h4>
                        <p className="text-[10.5px] font-medium text-sage-400">
                          External link
                        </p>
                      </div>
                    </div>
                    <ExternalLink className="h-4 w-4 shrink-0 text-sage-400" />
                  </a>
                ))}
              </section>
            )}

            {/* Empty batch */}
            {data.folders.length === 0 &&
              data.videos.length === 0 &&
              data.pdfs.length === 0 &&
              data.links.length === 0 && (
                <div className="surface rounded-card px-6 py-16 text-center">
                  <Sparkles className="mx-auto h-7 w-7 text-ember-400" />
                  <p className="mt-3 font-display text-lg font-semibold text-sand-100">
                    Material coming soon
                  </p>
                  <p className="mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-sand-400">
                    Lectures and notes for this course are being added.
                  </p>
                </div>
              )}
          </>
        )}
      </main>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/[0.12] px-5 py-10 text-center">
      <BookOpen className="mx-auto h-5 w-5 text-sand-500" />
      <p className="mt-2 text-[12.5px] font-medium text-sand-400">{text}</p>
    </div>
  );
}

export default function BatchExplorerPage() {
  return (
    <Suspense fallback={<PleaseWaitScreen title="Loading course..." />}>
      <BatchExplorerInner />
    </Suspense>
  );
}
