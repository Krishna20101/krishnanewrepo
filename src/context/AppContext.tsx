"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { SITE_CONFIG, apiUrl } from "@/config/siteConfig";
import {
  deleteOfflineBlobFromIdb,
  downloadStreamToVault,
  getOfflineObjectUrl,
  getVaultChunkCount,
  loadSavedDownloadsMeta,
  persistSavedDownloadsMeta,
  releaseOfflineObjectUrl,
  SavedDownloadItem,
  VAULT_CHUNK_BYTES,
} from "@/lib/clientDownloads";
// 🔐 Student login (alag file): src/lib/login/studentLogin.ts
import {
  clearStudentSession,
  readStudentSession,
  saveStudentSession,
} from "@/lib/login/studentLogin";
import PleaseWaitScreen from "@/components/PleaseWaitScreen";

interface PublicConfig {
  appName: string;
  appTagline: string;
  appDomain: string;
  telegramJoinUrl: string;
  telegramPopupEnabled: boolean;
  telegramPopupTitle: string;
  telegramPopupSubtitle: string;
  telegramAutoCloseSeconds: number;
  defaultImageUrl: string;
  appLogoUrl: string;
  announcementText: string;
  announcementEnabled: boolean;
  allowVideoDownload: boolean;
}

interface StartDownloadParams {
  batchId: string;
  batchName: string;
  itemId: string;
  title: string;
  kind: "VIDEO" | "PDF";
  thumbnail?: string;
  streamUrl: string;
  knownSize?: number;
}

interface AppContextValue {
  isHydrated: boolean;
  isLoggedIn: boolean;
  markLoggedIn: (token: string) => void;
  logoutStudent: () => void;
  showTelegramPopup: boolean;
  closeTelegramPopup: () => void;
  wishlistIds: string[];
  toggleWishlist: (batchId: string) => void;
  isWishlisted: (batchId: string) => boolean;
  pdfModalTitle: string | null;
  openPdfComingSoon: (title?: string) => void;
  closePdfComingSoon: () => void;
  config: PublicConfig;
  refreshConfig: () => Promise<void>;
  downloadsList: SavedDownloadItem[];
  startMediaDownload: (params: StartDownloadParams) => Promise<void>;
  pauseMediaDownload: (id: string) => void;
  resumeMediaDownload: (id: string) => Promise<void>;
  removeSavedDownload: (id: string) => Promise<void>;
  /** Vault (offline) se ready-to-play Object URL — null agar download nahi hua */
  getOfflineMediaUrl: (id: string, kind: "VIDEO" | "PDF") => Promise<string | null>;
  releaseOfflineMediaUrl: (id: string) => void;
  navigateWithWait: (href: string, waitMessage?: string) => void;
}

const DEFAULT_PUBLIC_CONFIG: PublicConfig = {
  appName: SITE_CONFIG.appName,
  appTagline: SITE_CONFIG.appTagline,
  appDomain: SITE_CONFIG.appDomain,
  telegramJoinUrl: SITE_CONFIG.telegramJoinUrl,
  telegramPopupEnabled: true,
  telegramPopupTitle: SITE_CONFIG.telegramPopupTitle,
  telegramPopupSubtitle: SITE_CONFIG.telegramPopupSubtitle,
  telegramAutoCloseSeconds: SITE_CONFIG.telegramAutoCloseSeconds,
  defaultImageUrl: SITE_CONFIG.defaultImageUrl,
  appLogoUrl: SITE_CONFIG.appLogoUrl,
  announcementText: "",
  announcementEnabled: false,
  allowVideoDownload: true,
};

const AppContext = createContext<AppContextValue | undefined>(undefined);

const STORAGE_WISHLIST_KEY = "shd_wishlist_v1";

export function AppProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const [isHydrated, setIsHydrated] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [showTelegramPopup, setShowTelegramPopup] = useState(false);
  const [wishlistIds, setWishlistIds] = useState<string[]>([]);
  const [pdfModalTitle, setPdfModalTitle] = useState<string | null>(null);
  const [config, setConfig] = useState<PublicConfig>(DEFAULT_PUBLIC_CONFIG);
  const [downloadsList, setDownloadsList] = useState<SavedDownloadItem[]>([]);
  const [navWaitLabel, setNavWaitLabel] = useState<string | null>(null);

  const activeDownloadSetRef = useRef<Set<string>>(new Set());

  // Clear route transition overlay whenever pathname changes
  useEffect(() => {
    setNavWaitLabel(null);
  }, [pathname]);

  const navigateWithWait = useCallback(
    (href: string, waitMessage = "Please wait, loading...") => {
      if (href === pathname) return;
      setNavWaitLabel(waitMessage);
      router.push(href);
      // Safety auto-clear after 4s even if route stays on same pathname with query change
      setTimeout(() => setNavWaitLabel(null), 4000);
    },
    [pathname, router]
  );

  const refreshConfig = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/config"), { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data?.ok && data.config) {
          setConfig((prev) => ({ ...prev, ...data.config }));
        }
      }
    } catch {
      // keep defaults
    }
  }, []);

  useEffect(() => {
    try {
      const savedToken = readStudentSession();
      if (savedToken) {
        setIsLoggedIn(true);
      }
      const savedWish = localStorage.getItem(STORAGE_WISHLIST_KEY);
      if (savedWish) {
        const parsed = JSON.parse(savedWish);
        if (Array.isArray(parsed)) {
          setWishlistIds(parsed.map(String));
        }
      }
      const savedDls = loadSavedDownloadsMeta();
      // Browser band ho gaya tha -> download "paused" (Resume button se continue)
      const cleanedDls = savedDls.map((d) =>
        d.status === "downloading" ? { ...d, status: "paused" as const } : d
      );
      setDownloadsList(cleanedDls);
    } catch {
      // ignore
    } finally {
      setIsHydrated(true);
    }
    refreshConfig();
  }, [refreshConfig]);

  const updateDownloadsState = useCallback(
    (updater: (prev: SavedDownloadItem[]) => SavedDownloadItem[]) => {
      setDownloadsList((prev) => {
        const next = updater(prev);
        persistSavedDownloadsMeta(next);
        return next;
      });
    },
    []
  );

  // ==========================================================================
  // 📥 IN-APP OFFLINE VAULT DOWNLOAD (resumable, low-RAM, no browser download)
  // ==========================================================================
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const downloadsListRef = useRef<SavedDownloadItem[]>([]);

  useEffect(() => {
    downloadsListRef.current = downloadsList;
  }, [downloadsList]);

  const runVaultDownload = useCallback(
    async (item: SavedDownloadItem, mimeType: string) => {
      const dlId = item.id;
      if (activeDownloadSetRef.current.has(dlId)) return;
      activeDownloadSetRef.current.add(dlId);

      const controller = new AbortController();
      abortControllersRef.current.set(dlId, controller);

      // Resume point: vault me pehle se kitne chunks maujood hain
      let startFrom = 0;
      try {
        const existingChunks = await getVaultChunkCount(dlId);
        if (existingChunks > 0) {
          startFrom = Math.max(
            0,
            Math.min(item.downloadedBytes || 0, existingChunks * VAULT_CHUNK_BYTES)
          );
        }
      } catch {
        startFrom = 0;
      }

      updateDownloadsState((prev) =>
        prev.map((x) =>
          x.id === dlId
            ? {
                ...x,
                status: "downloading",
                errorMsg: undefined,
                downloadedBytes: startFrom,
                progressPct:
                  x.totalBytes > 0
                    ? Math.round((startFrom / x.totalBytes) * 100)
                    : 1,
                storageMode: "in-app",
              }
            : x
        )
      );

      try {
        const result = await downloadStreamToVault({
          id: dlId,
          url: item.streamUrl,
          mimeType,
          knownSize: item.totalBytes || undefined,
          startFromBytes: startFrom,
          signal: controller.signal,
          onProgress: (downloaded, total, pct) => {
            updateDownloadsState((prev) =>
              prev.map((x) =>
                x.id === dlId
                  ? {
                      ...x,
                      downloadedBytes: downloaded,
                      totalBytes: total,
                      progressPct: pct,
                      status: "downloading",
                    }
                  : x
              )
            );
          },
        });

        updateDownloadsState((prev) =>
          prev.map((x) =>
            x.id === dlId
              ? {
                  ...x,
                  downloadedBytes: result.totalBytes,
                  totalBytes: result.totalBytes || x.totalBytes,
                  progressPct: 100,
                  status: "completed",
                  hasOfflineBlob: true,
                  chunkCount: result.chunkCount,
                  errorMsg: undefined,
                  savedAt: new Date().toISOString(),
                }
              : x
          )
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Download failed";
        const wasCancelled = controller.signal.aborted;
        updateDownloadsState((prev) =>
          prev.map((x) =>
            x.id === dlId
              ? {
                  ...x,
                  status: wasCancelled ? "paused" : "error",
                  errorMsg: wasCancelled ? undefined : msg,
                }
              : x
          )
        );
      } finally {
        abortControllersRef.current.delete(dlId);
        activeDownloadSetRef.current.delete(dlId);
      }
    },
    [updateDownloadsState]
  );

  const startMediaDownload = useCallback(
    async (params: StartDownloadParams) => {
      const dlId = `${params.kind}_${params.batchId}_${params.itemId}`;
      const mimeType = params.kind === "PDF" ? "application/pdf" : "video/mp4";

      const existing = downloadsListRef.current.find((x) => x.id === dlId);
      if (existing?.status === "downloading") return;

      const item: SavedDownloadItem = {
        id: dlId,
        batchId: params.batchId,
        batchName: params.batchName,
        itemId: params.itemId,
        title: params.title,
        kind: params.kind,
        thumbnail: params.thumbnail,
        streamUrl: params.streamUrl,
        totalBytes: params.knownSize || existing?.totalBytes || 0,
        downloadedBytes: existing?.downloadedBytes || 0,
        progressPct: existing?.progressPct || 1,
        status: "downloading",
        hasOfflineBlob: false,
        chunkCount: existing?.chunkCount || 0,
        savedAt: new Date().toISOString(),
        storageMode: "in-app",
      };

      updateDownloadsState((prev) => [item, ...prev.filter((x) => x.id !== dlId)]);
      await runVaultDownload(item, mimeType);
    },
    [runVaultDownload, updateDownloadsState]
  );

  const pauseMediaDownload = useCallback((id: string) => {
    const ctrl = abortControllersRef.current.get(id);
    if (ctrl) ctrl.abort();
  }, []);

  const resumeMediaDownload = useCallback(
    async (id: string) => {
      const item = downloadsListRef.current.find((x) => x.id === id);
      if (!item) return;
      const mimeType = item.kind === "PDF" ? "application/pdf" : "video/mp4";
      await runVaultDownload(item, mimeType);
    },
    [runVaultDownload]
  );

  const getOfflineMediaUrl = useCallback(
    async (id: string, kind: "VIDEO" | "PDF") => {
      return getOfflineObjectUrl(
        id,
        kind === "PDF" ? "application/pdf" : "video/mp4"
      );
    },
    []
  );

  const releaseOfflineMediaUrl = useCallback((id: string) => {
    releaseOfflineObjectUrl(id);
  }, []);

  const removeSavedDownload = useCallback(
    async (id: string) => {
      const ctrl = abortControllersRef.current.get(id);
      if (ctrl) ctrl.abort();
      await deleteOfflineBlobFromIdb(id);
      updateDownloadsState((prev) => prev.filter((x) => x.id !== id));
    },
    [updateDownloadsState]
  );

  const markLoggedIn = useCallback(
    (token: string) => {
      saveStudentSession(token);
      setIsLoggedIn(true);
      if (config.telegramPopupEnabled !== false) {
        setShowTelegramPopup(true);
      }
    },
    [config.telegramPopupEnabled]
  );

  const logoutStudent = useCallback(() => {
    clearStudentSession();
    setIsLoggedIn(false);
    setShowTelegramPopup(false);
  }, []);

  const closeTelegramPopup = useCallback(() => {
    setShowTelegramPopup(false);
  }, []);

  const toggleWishlist = useCallback((batchId: string) => {
    const id = String(batchId);
    setWishlistIds((prev) => {
      const exists = prev.includes(id);
      const next = exists ? prev.filter((x) => x !== id) : [id, ...prev];
      try {
        localStorage.setItem(STORAGE_WISHLIST_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const isWishlisted = useCallback(
    (batchId: string) => wishlistIds.includes(String(batchId)),
    [wishlistIds]
  );

  const openPdfComingSoon = useCallback((title?: string) => {
    setPdfModalTitle(title || "Class Notes & PDF");
  }, []);

  const closePdfComingSoon = useCallback(() => {
    setPdfModalTitle(null);
  }, []);

  return (
    <AppContext.Provider
      value={{
        isHydrated,
        isLoggedIn,
        markLoggedIn,
        logoutStudent,
        showTelegramPopup,
        closeTelegramPopup,
        wishlistIds,
        toggleWishlist,
        isWishlisted,
        pdfModalTitle,
        openPdfComingSoon,
        closePdfComingSoon,
        config,
        refreshConfig,
        downloadsList,
        startMediaDownload,
        pauseMediaDownload,
        resumeMediaDownload,
        removeSavedDownload,
        getOfflineMediaUrl,
        releaseOfflineMediaUrl,
        navigateWithWait,
      }}
    >
      {children}
      {navWaitLabel && <PleaseWaitScreen title={navWaitLabel} overlay />}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
