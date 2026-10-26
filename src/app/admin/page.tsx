"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Code2,
  Copy,
  Database,
  Download,
  Edit3,
  Eye,
  EyeOff,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  LayoutDashboard,
  Link2,
  Loader2,
  Lock,
  LogOut,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  Upload,
  Users,
  Video,
  X,
} from "lucide-react";
import GlowingBackButton from "@/components/GlowingBackButton";
import SafeImage from "@/components/SafeImage";
import { apiUrl } from "@/config/siteConfig";
import { useApp } from "@/context/AppContext";
import { buildYoutubeEmbedUrl } from "@/lib/youtube";

interface AdminBatchSummary {
  id: string;
  name: string;
  thumbnail: string;
  rawPrice: string;
  displayPrice: string;
  hidden: boolean;
  important?: boolean;
  sortOrder?: number;
  source?: string;
  totalFolders: number;
  totalVideos: number;
  linkedVideos: number;
  totalPdfs: number;
}

interface TreeNodeUI {
  id: string;
  parentId: string;
  title: string;
  type: "FOLDER" | "VIDEO" | "PDF" | "LINK";
  thumbnail: string;
  uploadedAt: string;
  videosCount: number;
  linkedVideosCount: number;
  subfoldersCount: number;
  filesCount: number;
  link?: string;
  hasSubfolders?: boolean;
  hasYoutubeEmbed?: boolean;
  hasTelegramStream?: boolean;
  hasRealPdf?: boolean;
  rawUrl?: string;
  embedUrl?: string;
  important?: boolean;
  sortOrder?: number;
}

interface SyncedTelegramGroupUI {
  id: string;
  chatInput: string;
  title: string;
  syncMode: "ADD_NEW" | "MERGE_JSON" | "BOTH";
  targetBatchId?: string;
  createdBatchId?: string;
  videosSynced: number;
  pdfsSynced: number;
  lastSyncedAt: string;
  syncStatus?: "ok" | "partial" | "error";
  lastSyncMessage?: string;
  mergedVideosCount?: number;
  mergedPdfsCount?: number;
  youtubeOnlyCount?: number;
}

interface QuickSearchVideo {
  id: string;
  title: string;
  folderPath: string;
  parentFolderId: string | null;
  rawUrl: string;
  embedUrl: string;
}

interface SavedLoginRow {
  id?: string;
  userId: string;
  password: string;
  ip?: string;
  createdAt: string;
}

type AdminTab =
  | "OVERVIEW"
  | "EXPLORER"
  | "TELEGRAM"
  | "COURSES"
  | "SETTINGS"
  | "LOGINS";

export default function AdminDashboardPage() {
  const { refreshConfig, config } = useApp();

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  // Admin Login Form
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showAdminPass, setShowAdminPass] = useState(false);
  const [authError, setAuthError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  // Global Dashboard State
  const [activeTab, setActiveTab] = useState<AdminTab>("EXPLORER");
  const [firebaseMode, setFirebaseMode] = useState<string>("local-fallback");
  const [stats, setStats] = useState({
    totalBatches: 0,
    hiddenBatches: 0,
    totalFolders: 0,
    totalVideos: 0,
    linkedVideos: 0,
    totalPdfs: 0,
    savedLogins: 0,
  });
  const [batches, setBatches] = useState<AdminBatchSummary[]>([]);
  const [toast, setToast] = useState("");

  // Folder & Video Tree Explorer State
  const [selectedBatchId, setSelectedBatchId] = useState<string>("");
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [folderTitle, setFolderTitle] = useState<string>("");
  const [breadcrumbs, setBreadcrumbs] = useState<
    Array<{ id: string; title: string }>
  >([]);
  const [treeItems, setTreeItems] = useState<TreeNodeUI[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [draftUrls, setDraftUrls] = useState<Record<string, string>>({});
  const [savingVideoId, setSavingVideoId] = useState<string | null>(null);

  // Quick Search inside Current Batch
  const [quickQuery, setQuickQuery] = useState("");
  const [allBatchVideos, setAllBatchVideos] = useState<QuickSearchVideo[]>([]);

  // Modals for Tree & Course Actions
  const [previewEmbed, setPreviewEmbed] = useState<{
    title: string;
    embedUrl: string;
  } | null>(null);

  const [addNodeModal, setAddNodeModal] = useState<{
    open: boolean;
    nodeType: "FOLDER" | "VIDEO" | "PDF" | "LINK";
    title: string;
    thumbnail: string;
    uploadedAt: string;
    youtubeUrl: string;
    link: string;
  }>({
    open: false,
    nodeType: "VIDEO",
    title: "",
    thumbnail: "",
    uploadedAt: "",
    youtubeUrl: "",
    link: "",
  });

  const [editNodeModal, setEditNodeModal] = useState<{
    open: boolean;
    nodeId: string;
    nodeType: string;
    title: string;
    thumbnail: string;
    uploadedAt: string;
    link: string;
  } | null>(null);

  // Courses Studio Modals
  const [createBatchModal, setCreateBatchModal] = useState({
    open: false,
    name: "",
    price: "999",
    thumbnail: "",
  });

  const [editBatchModal, setEditBatchModal] = useState<{
    id: string;
    name: string;
    price: string;
    thumbnail: string;
    hidden: boolean;
  } | null>(null);

  const [rawJsonModal, setRawJsonModal] = useState<{
    batchId: string;
    name: string;
    jsonText: string;
  } | null>(null);

  // Settings Tab State
  const [telegramJoinUrl, setTelegramJoinUrl] = useState("");
  const [telegramPopupEnabled, setTelegramPopupEnabled] = useState(true);
  const [telegramAutoCloseSeconds, setTelegramAutoCloseSeconds] = useState(5);
  const [telegramPopupTitle, setTelegramPopupTitle] = useState("");
  const [telegramPopupSubtitle, setTelegramPopupSubtitle] = useState("");
  const [defaultImageUrl, setDefaultImageUrl] = useState("");
  const [appLogoUrl, setAppLogoUrl] = useState("");
  const [defaultYoutubeUrl, setDefaultYoutubeUrl] = useState("");
  const [announcementEnabled, setAnnouncementEnabled] = useState(false);
  const [announcementText, setAnnouncementText] = useState("");
  const [cloudflareStreamWorkerUrl, setCloudflareStreamWorkerUrl] =
    useState("");
  const [allowVideoDownload, setAllowVideoDownload] = useState(true);

  // Telegram Sync Studio State
  const [tgConfigured, setTgConfigured] = useState(false);
  const [tgBotConfigured, setTgBotConfigured] = useState(false);
  const [tgMaskedApiId, setTgMaskedApiId] = useState("");
  const [tgApiId, setTgApiId] = useState("");
  const [tgApiHash, setTgApiHash] = useState("");
  const [tgSessionString, setTgSessionString] = useState("");
  const [tgBotToken, setTgBotToken] = useState("");
  const [savingTgCreds, setSavingTgCreds] = useState(false);

  const [tgChatInput, setTgChatInput] = useState("");
  const [tgTargetBatchId, setTgTargetBatchId] = useState("AUTO");
  const [tgCustomTitle, setTgCustomTitle] = useState("");
  const [tgCustomPrice, setTgCustomPrice] = useState("0");
  const [tgMessageLimit, setTgMessageLimit] = useState("1500");
  const [tgSyncing, setTgSyncing] = useState(false);
  const [tgSyncStatusMsg, setTgSyncStatusMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [syncedGroups, setSyncedGroups] = useState<SyncedTelegramGroupUI[]>([]);

  // Saved Logins State
  const [loginsList, setLoginsList] = useState<SavedLoginRow[]>([]);
  const [loginSearch, setLoginSearch] = useState("");
  const [revealPasswords, setRevealPasswords] = useState(false);

  // Live DB Diagnostics State
  const [lastDbError, setLastDbError] = useState<string | null>(null);
  const [testingDb, setTestingDb] = useState(false);
  const [dbTestBanner, setDbTestBanner] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3200);
  };

  const loadTelegramStudio = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/admin/telegram"), {
        cache: "no-store",
      });
      if (!res.ok) return;
      const d = await res.json();
      if (d?.ok) {
        setTgConfigured(Boolean(d.credentialsConfigured));
        setTgBotConfigured(Boolean(d.botConfigured));
        setTgMaskedApiId(d.maskedApiId || "");
        setSyncedGroups(d.syncedGroups || []);
      }
    } catch {
      // ignore
    }
  }, []);

  const handleSaveTelegramCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingTgCreds(true);
    setTgSyncStatusMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/telegram"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SAVE_CREDENTIALS",
          apiId: tgApiId,
          apiHash: tgApiHash,
          sessionString: tgSessionString,
          botToken: tgBotToken,
        }),
      });
      const d = await res.json();
      if (res.ok && d?.ok) {
        setTgSessionString("");
        setTgApiHash("");
        setTgBotToken("");
        setTgSyncStatusMsg({ ok: true, text: d.message });
        showToast("Telegram Session String AES-256 Encrypted & Saved!");
        await loadTelegramStudio();
      } else {
        setTgSyncStatusMsg({
          ok: false,
          text: d?.error || "Failed to connect Telegram credentials.",
        });
      }
    } catch {
      setTgSyncStatusMsg({
        ok: false,
        text: "Network error while verifying Telegram credentials.",
      });
    } finally {
      setSavingTgCreds(false);
    }
  };

  const handleRunTelegramSync = async (
    syncMode: "ADD_NEW" | "MERGE_JSON" | "BOTH",
    overrideGroup?: SyncedTelegramGroupUI
  ) => {
    const groupVal = overrideGroup ? overrideGroup.chatInput : tgChatInput;
    if (!groupVal.trim()) {
      setTgSyncStatusMsg({
        ok: false,
        text: "Please enter Telegram Group Username or Group ID (-100...)!",
      });
      return;
    }

    setTgSyncing(true);
    setTgSyncStatusMsg({
      ok: true,
      text: "Please wait... Scanning Telegram group messages & organizing chapters/videos/PDFs...",
    });

    try {
      const res = await fetch(apiUrl("/api/admin/telegram"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SYNC_GROUP",
          chatInput: groupVal.trim(),
          syncMode,
          targetBatchId: overrideGroup?.targetBatchId || tgTargetBatchId,
          existingCreatedBatchId: overrideGroup?.createdBatchId || "",
          customCourseTitle: overrideGroup ? overrideGroup.title : tgCustomTitle,
          customCoursePrice: tgCustomPrice,
          messageLimit: Number(tgMessageLimit) || 1500,
          apiId: tgApiId || undefined,
          apiHash: tgApiHash || undefined,
          sessionString: tgSessionString || undefined,
        }),
      });
      const d = await res.json();
      if (res.ok && d?.ok) {
        if (tgSessionString) {
          setTgSessionString("");
          setTgApiHash("");
        }
        const summaryParts: string[] = [
          `Scanned ${d.videosFound} Videos & ${d.pdfsFound} PDFs from "${d.groupTitle}"!`,
        ];
        if (d.youtubeOnlyCount) {
          summaryParts.push(
            `${d.youtubeOnlyCount} YouTube-link lectures auto-embedded`
          );
        }
        if (d.createdCourseName) {
          summaryParts.push(`Course Ready: "${d.createdCourseName}"`);
        }
        if (syncMode === "MERGE_JSON" || syncMode === "BOTH") {
          summaryParts.push(
            `JSON Merged: ${d.mergedVideosCount} Videos & ${d.mergedPdfsCount} PDFs`
          );
        }
        if (Array.isArray(d.problems) && d.problems.length > 0) {
          summaryParts.push(`⚠ ${d.problems.join(" | ")}`);
        }
        setTgSyncStatusMsg({
          ok: !d.partial && !(d.problems || []).length,
          text: summaryParts.join(" • "),
        });
        showToast(
          d.partial ? "Sync done with warnings — neeche list dekhein" : "Telegram Group Synced Live!"
        );
        await Promise.all([loadAdminOverview(), loadTelegramStudio()]);
        if (d.createdBatchId) {
          setSelectedBatchId(d.createdBatchId);
        }
      } else {
        setTgSyncStatusMsg({
          ok: false,
          text: d?.error || "Telegram group sync failed.",
        });
      }
    } catch {
      setTgSyncStatusMsg({
        ok: false,
        text: "Network timeout during sync. Try lowering max message scan limit if group has 5000+ items.",
      });
    } finally {
      setTgSyncing(false);
    }
  };

  const handleDeleteSyncedGroup = async (id: string) => {
    await fetch(apiUrl("/api/admin/telegram"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "DELETE_SYNC_RECORD", id }),
    });
    await loadTelegramStudio();
  };

  /** Sync se bana course (JSON) wapas hatao — list record bana rehta hai */
  const handleDeleteSyncedCourse = async (g: SyncedTelegramGroupUI) => {
    if (!g.createdBatchId) return;
    if (
      !window.confirm(
        `Course "${g.title}" JSON se delete kar dein? Videos/PDF links hat jayenge (Telegram group safe rahega).`
      )
    ) {
      return;
    }
    setTgSyncing(true);
    try {
      await fetch(apiUrl("/api/admin/telegram"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "DELETE_COURSE",
          batchId: g.createdBatchId,
          syncRecordId: g.id,
        }),
      });
      showToast("Course JSON se hata diya gaya");
      await Promise.all([loadAdminOverview(), loadTelegramStudio()]);
    } finally {
      setTgSyncing(false);
    }
  };

  const handleTestDbConnection = async () => {
    setTestingDb(true);
    setDbTestBanner(null);
    try {
      const res = await fetch(apiUrl("/api/admin/db-test"), { method: "POST" });
      const data = await res.json();
      setDbTestBanner({
        ok: Boolean(data?.ok),
        message: data?.message || "Connection tested.",
      });
      await loadAdminOverview();
    } catch {
      setDbTestBanner({
        ok: false,
        message: "Network error while testing database connection.",
      });
    } finally {
      setTestingDb(false);
    }
  };

  const loadAdminOverview = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/admin/me"), { cache: "no-store" });
      if (!res.ok) {
        setAuthorized(false);
        return;
      }
      const data = await res.json();
      if (data?.ok) {
        setAuthorized(true);
        setFirebaseMode(data.firebaseMode || "local-fallback");
        setLastDbError(data.lastDbError || null);
        setTgConfigured(Boolean(data.telegramConfigured));
        setStats(data.stats);
        setBatches(data.batches || []);
        if (data.batches?.length > 0) {
          setSelectedBatchId((prev) =>
            prev && data.batches.some((b: AdminBatchSummary) => b.id === prev)
              ? prev
              : data.batches[0].id
          );
        }
        if (data.settings) {
          setTelegramJoinUrl(data.settings.telegramJoinUrl || "");
          setTelegramPopupEnabled(data.settings.telegramPopupEnabled !== false);
          setTelegramAutoCloseSeconds(
            data.settings.telegramAutoCloseSeconds || 5
          );
          setTelegramPopupTitle(data.settings.telegramPopupTitle || "");
          setTelegramPopupSubtitle(data.settings.telegramPopupSubtitle || "");
          setDefaultImageUrl(data.settings.defaultImageUrl || "");
          setAppLogoUrl(data.settings.appLogoUrl || "");
          setDefaultYoutubeUrl(data.settings.defaultYoutubeUrl || "");
          setAnnouncementEnabled(Boolean(data.settings.announcementEnabled));
          setAnnouncementText(data.settings.announcementText || "");
          setCloudflareStreamWorkerUrl(
            data.settings.cloudflareStreamWorkerUrl || ""
          );
          setAllowVideoDownload(data.settings.allowVideoDownload !== false);
        }
      }
    } catch {
      setAuthorized(false);
    } finally {
      setCheckingAuth(false);
    }
  }, []);

  useEffect(() => {
    loadAdminOverview();
  }, [loadAdminOverview]);

  // Load current folder level inside Tree Explorer
  const loadTreeLevel = useCallback(
    async (bId: string, fId: string | null) => {
      if (!bId) return;
      setLoadingTree(true);
      try {
        const qs = `batchId=${encodeURIComponent(bId)}${
          fId ? `&folderId=${encodeURIComponent(fId)}` : ""
        }`;
        const res = await fetch(apiUrl(`/api/admin/tree?${qs}`), {
          cache: "no-store",
        });
        const data = await res.json();
        if (data?.ok) {
          setFolderTitle(data.folderTitle || "");
          setBreadcrumbs(data.breadcrumbs || []);
          setTreeItems(data.items || []);

          // Seed draft YouTube inputs for videos in this folder
          const nextDrafts: Record<string, string> = {};
          for (const item of data.items || []) {
            if (item.type === "VIDEO") {
              nextDrafts[item.id] = item.rawUrl || "";
            }
          }
          setDraftUrls((prev) => ({ ...prev, ...nextDrafts }));
        }
      } catch {
        // ignore
      } finally {
        setLoadingTree(false);
      }
    },
    []
  );

  // Load flat video index for quick jump search inside batch
  const loadQuickSearchIndex = useCallback(async (bId: string) => {
    if (!bId) return;
    try {
      const res = await fetch(
        apiUrl(`/api/admin/videos?batchId=${encodeURIComponent(bId)}`),
        { cache: "no-store" }
      );
      const data = await res.json();
      if (data?.ok && Array.isArray(data.videos)) {
        setAllBatchVideos(data.videos);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (authorized && selectedBatchId) {
      loadTreeLevel(selectedBatchId, currentFolderId);
    }
  }, [authorized, selectedBatchId, currentFolderId, loadTreeLevel]);

  useEffect(() => {
    if (authorized && selectedBatchId) {
      loadQuickSearchIndex(selectedBatchId);
    }
  }, [authorized, selectedBatchId, loadQuickSearchIndex]);

  const loadLogins = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/admin/logins"), {
        cache: "no-store",
      });
      const d = await res.json();
      if (d?.ok && Array.isArray(d.logins)) {
        setLoginsList(d.logins);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (authorized && activeTab === "LOGINS") {
      loadLogins();
    }
    if (authorized && activeTab === "TELEGRAM") {
      loadTelegramStudio();
    }
  }, [authorized, activeTab, loadLogins, loadTelegramStudio]);

  // Auth Handlers
  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setLoggingIn(true);
    try {
      const res = await fetch(apiUrl("/api/admin/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setAuthError(data?.error || "Access denied.");
        setLoggingIn(false);
        return;
      }
      setEmail("");
      setPassword("");
      await loadAdminOverview();
    } catch {
      setAuthError("Network error while verifying .env credentials.");
    } finally {
      setLoggingIn(false);
    }
  };

  const handleAdminLogout = async () => {
    await fetch(apiUrl("/api/admin/logout"), { method: "POST" });
    setAuthorized(false);
  };

  // Tree Navigation Helpers
  const openCourseInExplorer = (bId: string) => {
    setSelectedBatchId(bId);
    setCurrentFolderId(null);
    setQuickQuery("");
    setActiveTab("EXPLORER");
  };

  const stepUpOneFolder = () => {
    if (!currentFolderId) return;
    if (breadcrumbs.length >= 2) {
      setCurrentFolderId(breadcrumbs[breadcrumbs.length - 2].id);
    } else {
      setCurrentFolderId(null);
    }
  };

  // Save Video YouTube Link Live inside Folder Explorer
  const handleSaveVideoLink = async (video: TreeNodeUI) => {
    setSavingVideoId(video.id);
    try {
      const rawUrl = (draftUrls[video.id] ?? "").trim();
      const res = await fetch(apiUrl("/api/admin/videos"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: selectedBatchId,
          videoId: video.id,
          title: video.title,
          rawUrl,
        }),
      });
      const data = await res.json();
      if (data?.ok) {
        showToast(
          rawUrl
            ? `✓ Live Link Saved for "${video.title}"`
            : `Cleared link for "${video.title}"`
        );
        await Promise.all([
          loadTreeLevel(selectedBatchId, currentFolderId),
          loadQuickSearchIndex(selectedBatchId),
          loadAdminOverview(),
        ]);
      }
    } finally {
      setSavingVideoId(null);
    }
  };

  // Add Folder / Video / PDF / Link inside Current Folder
  const handleAddNodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addNodeModal.title.trim()) return;
    const res = await fetch(apiUrl("/api/admin/tree"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "ADD_NODE",
        batchId: selectedBatchId,
        parentFolderId: currentFolderId,
        nodeType: addNodeModal.nodeType,
        title: addNodeModal.title.trim(),
        thumbnail: addNodeModal.thumbnail.trim(),
        uploadedAt: addNodeModal.uploadedAt.trim(),
        youtubeUrl: addNodeModal.youtubeUrl.trim(),
        link: addNodeModal.link.trim(),
      }),
    });
    if (res.ok) {
      showToast(`Added ${addNodeModal.nodeType}: "${addNodeModal.title}"`);
      setAddNodeModal((p) => ({
        ...p,
        open: false,
        title: "",
        thumbnail: "",
        uploadedAt: "",
        youtubeUrl: "",
        link: "",
      }));
      await Promise.all([
        loadTreeLevel(selectedBatchId, currentFolderId),
        loadQuickSearchIndex(selectedBatchId),
        loadAdminOverview(),
      ]);
    }
  };

  // Edit Node Title / Thumbnail / Date / Link
  const handleEditNodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editNodeModal) return;
    const res = await fetch(apiUrl("/api/admin/tree"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "UPDATE_NODE",
        batchId: selectedBatchId,
        nodeId: editNodeModal.nodeId,
        title: editNodeModal.title,
        thumbnail: editNodeModal.thumbnail,
        uploadedAt: editNodeModal.uploadedAt,
        link: editNodeModal.link,
      }),
    });
    if (res.ok) {
      showToast("Updated item successfully!");
      setEditNodeModal(null);
      await Promise.all([
        loadTreeLevel(selectedBatchId, currentFolderId),
        loadQuickSearchIndex(selectedBatchId),
        loadAdminOverview(),
      ]);
    }
  };

  const handleDeleteNode = async (node: TreeNodeUI) => {
    if (
      !window.confirm(
        `Delete ${node.type} "${node.title}"${
          node.type === "FOLDER" ? " and all items inside it" : ""
        }?`
      )
    ) {
      return;
    }
    const res = await fetch(apiUrl("/api/admin/tree"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "DELETE_NODE",
        batchId: selectedBatchId,
        nodeId: node.id,
      }),
    });
    if (res.ok) {
      showToast(`Deleted "${node.title}"`);
      await Promise.all([
        loadTreeLevel(selectedBatchId, currentFolderId),
        loadQuickSearchIndex(selectedBatchId),
        loadAdminOverview(),
      ]);
    }
  };

  const handleMoveNode = async (
    nodeId: string,
    direction: "UP" | "DOWN" | "TOP" | "BOTTOM",
    exactPosition?: number
  ) => {
    const res = await fetch(apiUrl("/api/admin/tree"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "MOVE_NODE",
        batchId: selectedBatchId,
        nodeId,
        direction,
        position: exactPosition,
      }),
    });
    if (res.ok) {
      showToast("Updated item position!");
      await loadTreeLevel(selectedBatchId, currentFolderId);
    }
  };

  const handleSetNodePositionPrompt = async (
    node: TreeNodeUI,
    currentRank: number,
    maxRank: number
  ) => {
    const input = window.prompt(
      `Enter position number (1 to ${maxRank}) for "${node.title}":`,
      String(currentRank)
    );
    if (!input) return;
    const pos = parseInt(input.trim(), 10);
    if (Number.isNaN(pos) || pos < 1) return;
    await handleMoveNode(node.id, "UP", pos);
  };

  const handleToggleNodeImportant = async (node: TreeNodeUI) => {
    const nextImp = !node.important;
    const res = await fetch(apiUrl("/api/admin/tree"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "TOGGLE_IMPORTANT",
        batchId: selectedBatchId,
        nodeId: node.id,
        important: nextImp,
      }),
    });
    if (res.ok) {
      showToast(
        nextImp
          ? `⭐ Pinned "${node.title}" to TOP as Important!`
          : `Unpinned "${node.title}"`
      );
      await loadTreeLevel(selectedBatchId, currentFolderId);
    }
  };

  const handleToggleBatchImportant = async (batch: AdminBatchSummary) => {
    const nextImp = !batch.important;
    const res = await fetch(apiUrl("/api/admin/batches"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "TOGGLE_IMPORTANT_BATCH",
        id: batch.id,
        important: nextImp,
      }),
    });
    if (res.ok) {
      showToast(
        nextImp
          ? `⭐ Course "${batch.name}" pinned to #1 TOP!`
          : `Removed Important pin from "${batch.name}"`
      );
      await loadAdminOverview();
    }
  };

  const handleReorderBatch = async (
    batchId: string,
    direction: "UP" | "DOWN" | "TOP" | "BOTTOM",
    exactPosition?: number
  ) => {
    const res = await fetch(apiUrl("/api/admin/batches"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "REORDER_BATCH",
        id: batchId,
        direction,
        position: exactPosition,
      }),
    });
    if (res.ok) {
      showToast("Course order updated live!");
      await loadAdminOverview();
    }
  };

  const handleSetBatchPositionPrompt = async (
    batch: AdminBatchSummary,
    currentRank: number
  ) => {
    const input = window.prompt(
      `Set exact website position (1 to ${batches.length}) for "${batch.name}":`,
      String(currentRank)
    );
    if (!input) return;
    const pos = parseInt(input.trim(), 10);
    if (Number.isNaN(pos) || pos < 1) return;
    await handleReorderBatch(batch.id, "UP", pos);
  };

  // Course / JSON Batch Studio Handlers
  const handleJsonFilesUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    let uploadedCount = 0;
    let firstId = "";
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const res = await fetch(apiUrl("/api/admin/batches"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchJson: json }),
        });
        const d = await res.json();
        if (res.ok && d?.ok) {
          uploadedCount += 1;
          if (!firstId) firstId = d.batchId;
        }
      } catch {
        // skip invalid file
      }
    }

    e.target.value = "";
    showToast(`Imported ${uploadedCount} JSON Course(s) successfully!`);
    await loadAdminOverview();
    if (firstId) setSelectedBatchId(firstId);
  };

  const handleCreateBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createBatchModal.name.trim()) return;
    const res = await fetch(apiUrl("/api/admin/batches"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "CREATE_BATCH",
        name: createBatchModal.name.trim(),
        price: createBatchModal.price.trim(),
        thumbnail: createBatchModal.thumbnail.trim(),
      }),
    });
    const d = await res.json();
    if (res.ok && d?.ok) {
      showToast(`Created Course "${createBatchModal.name}"!`);
      setCreateBatchModal({
        open: false,
        name: "",
        price: "999",
        thumbnail: "",
      });
      await loadAdminOverview();
      openCourseInExplorer(d.batchId);
    }
  };

  const handleUpdateBatchMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editBatchModal) return;
    const res = await fetch(apiUrl("/api/admin/batches"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "UPDATE_BATCH_META",
        id: editBatchModal.id,
        name: editBatchModal.name,
        price: editBatchModal.price,
        thumbnail: editBatchModal.thumbnail,
        hidden: editBatchModal.hidden,
      }),
    });
    if (res.ok) {
      showToast("Updated course details!");
      setEditBatchModal(null);
      await loadAdminOverview();
    }
  };

  const handleToggleBatchHidden = async (batch: AdminBatchSummary) => {
    const res = await fetch(apiUrl("/api/admin/batches"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "UPDATE_BATCH_META",
        id: batch.id,
        hidden: !batch.hidden,
      }),
    });
    if (res.ok) {
      showToast(
        !batch.hidden
          ? `Hidden "${batch.name}" from students`
          : `Published "${batch.name}" live!`
      );
      await loadAdminOverview();
    }
  };

  const handleDeleteBatch = async (batch: AdminBatchSummary) => {
    if (
      !window.confirm(
        `Permanently delete course "${batch.name}" (ID: ${batch.id})?`
      )
    ) {
      return;
    }
    const res = await fetch(
      apiUrl(`/api/admin/batches?id=${encodeURIComponent(batch.id)}`),
      { method: "DELETE" }
    );
    if (res.ok) {
      showToast(`Deleted "${batch.name}"`);
      if (selectedBatchId === batch.id) {
        setSelectedBatchId("");
        setCurrentFolderId(null);
      }
      await loadAdminOverview();
    }
  };

  const handleOpenRawJson = async (batch: AdminBatchSummary) => {
    const res = await fetch(
      apiUrl(
        `/api/admin/tree?batchId=${encodeURIComponent(batch.id)}&export=1`
      ),
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data?.ok && data.batchJson) {
      setRawJsonModal({
        batchId: batch.id,
        name: batch.name,
        jsonText: JSON.stringify(data.batchJson, null, 2),
      });
    }
  };

  const handleSaveRawJson = async () => {
    if (!rawJsonModal) return;
    try {
      const parsed = JSON.parse(rawJsonModal.jsonText);
      const res = await fetch(apiUrl("/api/admin/batches"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchJson: parsed }),
      });
      if (res.ok) {
        showToast("Raw JSON saved & live!");
        setRawJsonModal(null);
        await Promise.all([
          loadAdminOverview(),
          loadTreeLevel(selectedBatchId, currentFolderId),
        ]);
      }
    } catch {
      alert("Invalid JSON syntax! Please fix syntax errors before saving.");
    }
  };

  const handleDownloadBatchJson = async (batch: AdminBatchSummary) => {
    const res = await fetch(
      apiUrl(
        `/api/admin/tree?batchId=${encodeURIComponent(batch.id)}&export=1`
      ),
      { cache: "no-store" }
    );
    const data = await res.json();
    if (data?.ok && data.batchJson) {
      const blob = new Blob([JSON.stringify(data.batchJson, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${batch.name.replace(/[^a-zA-Z0-9_-]+/g, "_")}_${
        batch.id
      }.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  // Settings Save
  const handleSaveSiteSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(apiUrl("/api/admin/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        telegramJoinUrl,
        telegramPopupEnabled,
        telegramAutoCloseSeconds,
        telegramPopupTitle,
        telegramPopupSubtitle,
        defaultImageUrl,
        appLogoUrl,
        defaultYoutubeUrl,
        announcementEnabled,
        announcementText,
        cloudflareStreamWorkerUrl,
        allowVideoDownload,
      }),
    });
    const data = await res.json();
    if (data?.ok) {
      await refreshConfig();
      showToast("Website settings updated live!");
    }
  };

  // Logins Helpers
  const handleDeleteLoginEntry = async (id?: string) => {
    if (!id) return;
    const res = await fetch(
      apiUrl(`/api/admin/logins?id=${encodeURIComponent(id)}`),
      { method: "DELETE" }
    );
    if (res.ok) {
      setLoginsList((prev) => prev.filter((x) => x.id !== id));
      showToast("Deleted login entry.");
      loadAdminOverview();
    }
  };

  const exportLoginsCsv = () => {
    const header = "UserId,Password,IP,CreatedAt\n";
    const rows = loginsList
      .map(
        (r) =>
          `"${(r.userId || "").replace(/"/g, '""')}","${(
            r.password || ""
          ).replace(/"/g, '""')}","${r.ip || ""}","${r.createdAt || ""}"`
      )
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `study_helper_doc_logins_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Derived Explorer Lists
  const foldersInCurrentLevel = useMemo(
    () => treeItems.filter((i) => i.type === "FOLDER"),
    [treeItems]
  );
  const videosInCurrentLevel = useMemo(
    () => treeItems.filter((i) => i.type === "VIDEO"),
    [treeItems]
  );
  const otherItemsInCurrentLevel = useMemo(
    () => treeItems.filter((i) => i.type === "PDF" || i.type === "LINK"),
    [treeItems]
  );

  const activeBatchSummary = useMemo(
    () => batches.find((b) => b.id === selectedBatchId) || null,
    [batches, selectedBatchId]
  );

  const quickSearchMatches = useMemo(() => {
    const q = quickQuery.trim().toLowerCase();
    if (!q) return [];
    return allBatchVideos
      .filter(
        (v) =>
          v.title.toLowerCase().includes(q) ||
          v.folderPath.toLowerCase().includes(q) ||
          v.id.includes(q)
      )
      .slice(0, 12);
  }, [allBatchVideos, quickQuery]);

  const filteredLogins = useMemo(() => {
    const q = loginSearch.trim().toLowerCase();
    if (!q) return loginsList;
    return loginsList.filter(
      (r) =>
        (r.userId || "").toLowerCase().includes(q) ||
        (r.ip || "").toLowerCase().includes(q)
    );
  }, [loginsList, loginSearch]);

  if (checkingAuth) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm font-bold text-cyan-300">
        Verifying .env Protected Admin Session...
      </div>
    );
  }

  // ==========================================================================
  // .ENV PROTECTED ADMIN LOGIN GATE
  // ==========================================================================
  if (!authorized) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 py-10">
        <div className="glass-card relative w-full max-w-md overflow-hidden rounded-3xl border border-cyan-400/30 p-8 shadow-glow-cyan">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-cyan-400 via-purple-500 to-rose-500" />
          <div className="mb-5 flex items-center justify-between">
            <GlowingBackButton fallbackHref="/" />
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/35 bg-emerald-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              .env Protected
            </span>
          </div>

          <h1 className="text-2xl font-black text-white">
            Admin Control Vault
          </h1>
          <p className="mt-1 text-xs font-medium text-slate-400">
            100% Backend <code className="text-cyan-300">.env</code>{" "}
            Authentication • Zero Client Exposure
          </p>

          <form onSubmit={handleAdminLogin} className="mt-6 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-300">
                Admin Login ID / Email
              </label>
              <input
                type="text"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter ADMIN_EMAIL from .env"
                className="w-full rounded-2xl border border-white/15 bg-[#060919] px-4 py-3 text-sm font-semibold text-white outline-none focus:border-cyan-400"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-300">
                Admin Password
              </label>
              <div className="relative">
                <input
                  type={showAdminPass ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter ADMIN_PASSWORD from .env"
                  className="w-full rounded-2xl border border-white/15 bg-[#060919] py-3 pl-4 pr-11 text-sm font-semibold text-white outline-none focus:border-purple-400"
                />
                <button
                  type="button"
                  onClick={() => setShowAdminPass((s) => !s)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  {showAdminPass ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {authError && (
              <div className="rounded-xl border border-rose-500/40 bg-rose-500/15 p-3 text-xs font-bold text-rose-200">
                {authError}
              </div>
            )}

            <button
              type="submit"
              disabled={loggingIn}
              className="w-full rounded-2xl bg-gradient-to-r from-cyan-500 via-indigo-600 to-purple-600 py-3.5 text-xs font-black uppercase tracking-widest text-white shadow-glow-cyan transition hover:brightness-110 disabled:opacity-50"
            >
              {loggingIn ? "VERIFYING..." : "UNLOCK ADMIN COMMAND CENTER"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const coveragePct =
    stats.totalVideos > 0
      ? Math.round((stats.linkedVideos / stats.totalVideos) * 100)
      : 0;

  return (
    <div className="mx-auto min-h-screen max-w-7xl pb-24">
      {/* Live Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-2xl border border-cyan-400/50 bg-[#0d1435]/95 px-4 py-3 text-xs font-bold text-cyan-200 shadow-glow-cyan backdrop-blur-xl">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <span>{toast}</span>
        </div>
      )}

      {/* Top Sticky Admin Bar */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#07091b]/92 px-4 py-3.5 backdrop-blur-xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <GlowingBackButton fallbackHref="/" />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="bg-gradient-to-r from-white via-cyan-200 to-purple-300 bg-clip-text text-lg sm:text-xl font-black uppercase tracking-wider text-transparent">
                  Study helper Doc • Command Center
                </h1>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] font-bold">
                <span className="text-emerald-400">
                  ● .env Server-Only Security Active
                </span>
                <span className="text-slate-600">|</span>
                <span
                  className={
                    lastDbError
                      ? "text-rose-300"
                      : firebaseMode === "admin-rtdb"
                      ? "text-cyan-300"
                      : firebaseMode === "web-rtdb"
                      ? "text-emerald-300"
                      : "text-amber-300"
                  }
                >
                  {lastDbError
                    ? "⚠ Firebase Config Warning (Click Website & .env Tab)"
                    : firebaseMode === "admin-rtdb"
                    ? "Firebase Realtime DB Connected (100% Locked)"
                    : firebaseMode === "web-rtdb"
                    ? "Firebase Realtime DB (.env URL)"
                    : "Local Server Store Active (Add Firebase in .env for Cloud)"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              href="/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/35 bg-cyan-500/10 px-3 py-2 text-xs font-extrabold text-cyan-200 transition hover:bg-cyan-500/20"
            >
              <Globe className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">View Live Site</span>
            </a>
            <button
              type="button"
              onClick={handleAdminLogout}
              className="inline-flex items-center gap-1.5 rounded-xl border border-rose-400/40 bg-rose-500/15 px-3.5 py-2 text-xs font-extrabold text-rose-200 transition hover:bg-rose-500/25"
            >
              <LogOut className="h-4 w-4" />
              <span>Lock</span>
            </button>
          </div>
        </div>

        {/* Navigation Pill Bar */}
        <div className="mt-3.5 flex gap-2 overflow-x-auto pb-1">
          {[
            {
              id: "EXPLORER",
              label: "Folder & Video Tree",
              icon: FolderOpen,
            },
            {
              id: "TELEGRAM",
              label: "Telegram Sync Studio",
              icon: Send,
            },
            {
              id: "COURSES",
              label: `All Courses (${stats.totalBatches})`,
              icon: Database,
            },
            {
              id: "OVERVIEW",
              label: "Analytics Overview",
              icon: LayoutDashboard,
            },
            {
              id: "SETTINGS",
              label: "Website & .env Security",
              icon: Settings,
            },
            {
              id: "LOGINS",
              label: `Saved Logins (${stats.savedLogins})`,
              icon: Users,
            },
          ].map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id as AdminTab)}
                className={`inline-flex shrink-0 items-center gap-2 rounded-2xl border px-4 py-2 text-xs font-extrabold uppercase tracking-wider transition ${
                  active
                    ? "border-cyan-400/70 bg-gradient-to-r from-cyan-500/25 via-indigo-500/25 to-purple-600/25 text-white shadow-glow-cyan"
                    : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
                }`}
              >
                <Icon className="h-4 w-4 text-cyan-300" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </header>

      <main className="px-4 pt-6">
        {/* ====================================================================
            TAB 1: INTERACTIVE COURSE -> FOLDER -> SUBFOLDER -> VIDEO EXPLORER
           ==================================================================== */}
        {activeTab === "EXPLORER" && (
          <div className="space-y-5">
            {/* Step 1: Course Selector + Quick Jump Search */}
            <div className="glass-card rounded-3xl border border-cyan-400/25 p-4 sm:p-5">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-end">
                {/* Course Dropdown */}
                <div className="lg:col-span-5">
                  <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-black uppercase tracking-widest text-cyan-300">
                    <span>1. Select Course / Batch</span>
                  </label>
                  <select
                    value={selectedBatchId}
                    onChange={(e) => {
                      setSelectedBatchId(e.target.value);
                      setCurrentFolderId(null);
                      setQuickQuery("");
                    }}
                    className="w-full rounded-2xl border border-white/15 bg-[#060919] px-4 py-3 text-sm font-extrabold text-white outline-none focus:border-cyan-400"
                  >
                    {batches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.hidden ? "🙈 [HIDDEN] " : "🟢 "}
                        {b.name} — ({b.linkedVideos}/{b.totalVideos} Linked)
                      </option>
                    ))}
                  </select>
                </div>

                {/* Quick Search Any Video inside Selected Course */}
                <div className="relative lg:col-span-4">
                  <label className="mb-1.5 block text-[11px] font-black uppercase tracking-widest text-purple-300">
                    Quick Jump to Any Folder / Lecture
                  </label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      value={quickQuery}
                      onChange={(e) => setQuickQuery(e.target.value)}
                      placeholder="Search lecture in this course..."
                      className="w-full rounded-2xl border border-white/15 bg-[#060919] py-3 pl-10 pr-9 text-xs font-bold text-white outline-none focus:border-purple-400"
                    />
                    {quickQuery && (
                      <button
                        type="button"
                        onClick={() => setQuickQuery("")}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {/* Quick Jump Dropdown Results */}
                  {quickQuery.trim() && (
                    <div className="absolute left-0 right-0 top-[76px] z-40 max-h-72 overflow-y-auto rounded-2xl border border-purple-400/40 bg-[#090d24] p-2 shadow-2xl">
                      {quickSearchMatches.length === 0 ? (
                        <p className="p-3 text-center text-xs text-slate-400">
                          No matching lecture in this course.
                        </p>
                      ) : (
                        quickSearchMatches.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => {
                              setCurrentFolderId(m.parentFolderId);
                              setQuickQuery("");
                            }}
                            className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left hover:bg-white/10"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-xs font-extrabold text-white">
                                {m.title}
                              </p>
                              <p className="truncate text-[10px] font-semibold text-purple-300">
                                📁 {m.folderPath}
                              </p>
                            </div>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black ${
                                m.embedUrl
                                  ? "bg-emerald-500/20 text-emerald-300"
                                  : "bg-amber-500/20 text-amber-300"
                              }`}
                            >
                              {m.embedUrl ? "Linked" : "Add Link →"}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* Add Folder / Add Video Buttons inside Current Level */}
                <div className="flex flex-wrap gap-2 lg:col-span-3 lg:justify-end">
                  <button
                    type="button"
                    onClick={() =>
                      setAddNodeModal({
                        open: true,
                        nodeType: "FOLDER",
                        title: "",
                        thumbnail: "",
                        uploadedAt: "",
                        youtubeUrl: "",
                        link: "",
                      })
                    }
                    className="inline-flex flex-1 lg:flex-none items-center justify-center gap-1.5 rounded-2xl border border-cyan-400/45 bg-cyan-500/15 px-3.5 py-3 text-xs font-black uppercase tracking-wider text-cyan-200 transition hover:bg-cyan-500/25"
                  >
                    <FolderPlus className="h-4 w-4" />
                    <span>+ Folder</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setAddNodeModal({
                        open: true,
                        nodeType: "VIDEO",
                        title: "",
                        thumbnail: "",
                        uploadedAt: "",
                        youtubeUrl: "",
                        link: "",
                      })
                    }
                    className="inline-flex flex-1 lg:flex-none items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-purple-600 to-indigo-600 px-3.5 py-3 text-xs font-black uppercase tracking-wider text-white shadow-glow-purple transition hover:brightness-110"
                  >
                    <Plus className="h-4 w-4" />
                    <span>+ Video</span>
                  </button>
                </div>
              </div>

              {/* Breadcrumb Navigation Bar */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#060919]/80 px-3.5 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
                  {currentFolderId && (
                    <button
                      type="button"
                      onClick={stepUpOneFolder}
                      className="mr-2 rounded-xl border border-cyan-400/50 bg-cyan-500/15 px-2.5 py-1 text-[11px] font-black text-cyan-200 hover:bg-cyan-500/25"
                    >
                      ‹ Back Folder
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setCurrentFolderId(null)}
                    className={`rounded-lg px-2 py-1 transition ${
                      !currentFolderId
                        ? "bg-cyan-500/20 text-cyan-200 font-black"
                        : "text-slate-300 hover:text-cyan-300"
                    }`}
                  >
                    🏠 {activeBatchSummary?.name || "Course Root"}
                  </button>

                  {breadcrumbs.map((crumb, idx) => {
                    const isLast = idx === breadcrumbs.length - 1;
                    return (
                      <React.Fragment key={crumb.id}>
                        <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
                        <button
                          type="button"
                          onClick={() => setCurrentFolderId(crumb.id)}
                          className={`rounded-lg px-2 py-1 transition ${
                            isLast
                              ? "bg-purple-500/25 text-purple-200 font-black"
                              : "text-slate-300 hover:text-cyan-300"
                          }`}
                        >
                          📁 {crumb.title}
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>

                {activeBatchSummary && (
                  <span className="text-[11px] font-extrabold text-emerald-300">
                    Course Linked: {activeBatchSummary.linkedVideos} /{" "}
                    {activeBatchSummary.totalVideos} Videos
                  </span>
                )}
              </div>
            </div>

            {loadingTree ? (
              <div className="glass-card rounded-3xl border border-white/10 p-10 text-center text-sm font-bold text-cyan-300">
                Opening Folder Contents...
              </div>
            ) : (
              <>
                {/* SECTION A: SUBFOLDERS IN THIS LEVEL */}
                {foldersInCurrentLevel.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-1">
                      <h2 className="text-xs font-black uppercase tracking-widest text-cyan-300">
                        📁 Folders Inside &ldquo;{folderTitle}&rdquo; (
                        {foldersInCurrentLevel.length}) — Click Any Folder to
                        Open
                      </h2>
                    </div>

                    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
                      {foldersInCurrentLevel.map((f, idx) => {
                        const allLinked =
                          f.videosCount > 0 &&
                          f.linkedVideosCount >= f.videosCount;
                        return (
                          <div
                            key={f.id}
                            className={`glass-card flex flex-col gap-3 rounded-3xl border p-3.5 ${
                              f.important
                                ? "border-amber-400/60 bg-amber-500/[0.04]"
                                : "border-white/10"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              {/* Clickable Main Folder Area */}
                              <button
                                type="button"
                                onClick={() => setCurrentFolderId(f.id)}
                                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                              >
                                <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-2xl border border-cyan-400/35 bg-[#0d1230] p-0.5">
                                  <SafeImage
                                    src={f.thumbnail}
                                    fallbackSrc={config.defaultImageUrl}
                                    alt={f.title}
                                    className="h-full w-full rounded-[14px] object-cover"
                                  />
                                </div>

                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {f.important && (
                                      <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-black text-slate-950">
                                        <Star className="h-2.5 w-2.5 fill-slate-950" />
                                        TOP PINNED
                                      </span>
                                    )}
                                    <h3 className="truncate text-sm sm:text-base font-extrabold text-white">
                                      {f.title}
                                    </h3>
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] font-bold">
                                    {f.subfoldersCount > 0 && (
                                      <span className="rounded-md bg-cyan-500/15 px-2 py-0.5 text-cyan-300">
                                        {f.subfoldersCount} Subfolders
                                      </span>
                                    )}
                                    {f.videosCount > 0 && (
                                      <span
                                        className={`rounded-md px-2 py-0.5 ${
                                          allLinked
                                            ? "bg-emerald-500/20 text-emerald-300"
                                            : "bg-amber-500/20 text-amber-300"
                                        }`}
                                      >
                                        {f.linkedVideosCount}/{f.videosCount}{" "}
                                        Videos Linked
                                      </span>
                                    )}
                                    {f.filesCount > 0 && (
                                      <span className="rounded-md bg-purple-500/15 px-2 py-0.5 text-purple-300">
                                        {f.filesCount} PDFs
                                      </span>
                                    )}
                                    {f.subfoldersCount === 0 &&
                                      f.videosCount === 0 &&
                                      f.filesCount === 0 && (
                                        <span className="text-slate-400">
                                          Empty Folder
                                        </span>
                                      )}
                                  </div>
                                </div>
                              </button>

                              <button
                                type="button"
                                onClick={() => setCurrentFolderId(f.id)}
                                className="shrink-0 rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-3 py-2 text-[11px] font-black uppercase text-cyan-200 hover:bg-cyan-500/25"
                              >
                                Open →
                              </button>
                            </div>

                            {/* Folder Rank, ⭐ Important Pin & Reorder Controls */}
                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2.5">
                              <div className="flex flex-wrap items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleSetNodePositionPrompt(
                                      f,
                                      idx + 1,
                                      foldersInCurrentLevel.length
                                    )
                                  }
                                  title="Click to type exact position number (1, 2, 3...)"
                                  className="rounded-lg border border-cyan-400/35 bg-cyan-500/10 px-2 py-1 text-[11px] font-black text-cyan-200 hover:bg-cyan-500/20"
                                >
                                  #{idx + 1} Set No.
                                </button>

                                <button
                                  type="button"
                                  onClick={() => handleToggleNodeImportant(f)}
                                  title="Pin to #1 Top with Star Badge"
                                  className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-black transition ${
                                    f.important
                                      ? "border-amber-400 bg-amber-400 text-slate-950"
                                      : "border-amber-400/35 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                                  }`}
                                >
                                  <Star
                                    className={`h-3 w-3 ${
                                      f.important ? "fill-slate-950" : ""
                                    }`}
                                  />
                                  <span>{f.important ? "Starred" : "Star"}</span>
                                </button>

                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => handleMoveNode(f.id, "TOP")}
                                  title="Move to Very Top (#1)"
                                  className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/15 hover:text-white disabled:opacity-25"
                                >
                                  <ChevronsUp className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => handleMoveNode(f.id, "UP")}
                                  title="Move Up"
                                  className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/15 hover:text-white disabled:opacity-25"
                                >
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    idx === foldersInCurrentLevel.length - 1
                                  }
                                  onClick={() => handleMoveNode(f.id, "DOWN")}
                                  title="Move Down"
                                  className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/15 hover:text-white disabled:opacity-25"
                                >
                                  <ArrowDown className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    idx === foldersInCurrentLevel.length - 1
                                  }
                                  onClick={() => handleMoveNode(f.id, "BOTTOM")}
                                  title="Move to Very Bottom"
                                  className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/15 hover:text-white disabled:opacity-25"
                                >
                                  <ChevronsDown className="h-3.5 w-3.5" />
                                </button>
                              </div>

                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEditNodeModal({
                                      open: true,
                                      nodeId: f.id,
                                      nodeType: "FOLDER",
                                      title: f.title,
                                      thumbnail: f.thumbnail,
                                      uploadedAt: f.uploadedAt,
                                      link: "",
                                    })
                                  }
                                  title="Rename / Edit Folder"
                                  className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-cyan-300"
                                >
                                  <Edit3 className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteNode(f)}
                                  title="Delete Folder"
                                  className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Deepest Leaf Folder Indicator when no more subfolders exist */}
                {currentFolderId && foldersInCurrentLevel.length === 0 && (
                  <div className="flex items-center justify-between rounded-2xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-2.5 text-xs font-bold text-emerald-200">
                    <span>
                      ✓ Final Chapter Folder Reached (&ldquo;{folderTitle}
                      &rdquo;) — No further subfolders. Add/Edit YouTube links
                      on all videos below!
                    </span>
                  </div>
                )}

                {/* SECTION B: VIDEOS IN THIS FOLDER (LIVE YOUTUBE LINK EDITOR) */}
                {videosInCurrentLevel.length > 0 && (
                  <div className="space-y-3">
                    <h2 className="px-1 text-xs font-black uppercase tracking-widest text-purple-300">
                      🎬 Video Lectures in &ldquo;{folderTitle}&rdquo; (
                      {videosInCurrentLevel.length}) — Live YouTube Link Editor
                    </h2>

                    <div className="space-y-3">
                      {videosInCurrentLevel.map((v, idx) => {
                        const currentDraft = draftUrls[v.id] ?? "";
                        const isDirty = currentDraft !== (v.rawUrl || "");

                        return (
                          <div
                            key={v.id}
                            className={`glass-card flex flex-col gap-3.5 rounded-3xl border p-4 transition lg:flex-row lg:items-center ${
                              v.hasYoutubeEmbed
                                ? "border-emerald-400/30"
                                : "border-white/10"
                            }`}
                          >
                            {/* Left: Thumbnail + Lecture Info */}
                            <div className="flex min-w-0 flex-1 items-center gap-3.5">
                              <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-[#0b0f26]">
                                <SafeImage
                                  src={v.thumbnail}
                                  fallbackSrc={config.defaultImageUrl}
                                  alt={v.title}
                                  className="h-full w-full object-cover"
                                />
                              </div>

                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  {v.hasYoutubeEmbed ? (
                                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/20 px-2.5 py-0.5 text-[10px] font-black text-emerald-300">
                                      ● LIVE LINKED
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/35 bg-amber-500/15 px-2.5 py-0.5 text-[10px] font-black text-amber-300">
                                      ○ NO LINK YET
                                    </span>
                                  )}
                                  <span className="text-[10px] font-mono text-slate-400">
                                    ID: {v.id}
                                  </span>
                                  {v.uploadedAt && (
                                    <span className="text-[10px] text-slate-400">
                                      • {v.uploadedAt}
                                    </span>
                                  )}
                                </div>

                                <h4 className="mt-1 truncate text-sm sm:text-base font-extrabold text-white">
                                  {v.title}
                                </h4>
                              </div>
                            </div>

                            {/* Right: Inline YouTube URL Input + Live Save + Preview + Edit/Delete */}
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center lg:w-[530px]">
                              <div className="relative flex-1">
                                <Link2 className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cyan-300" />
                                <input
                                  type="text"
                                  value={currentDraft}
                                  onChange={(e) =>
                                    setDraftUrls((prev) => ({
                                      ...prev,
                                      [v.id]: e.target.value,
                                    }))
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      handleSaveVideoLink(v);
                                    }
                                  }}
                                  placeholder="Paste YouTube Watch / Live / Short / Embed URL..."
                                  className="w-full rounded-xl border border-white/15 bg-[#060919] py-2.5 pl-9 pr-3 text-xs font-semibold text-white outline-none focus:border-cyan-400"
                                />
                              </div>

                              <div className="flex shrink-0 items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={savingVideoId === v.id}
                                  onClick={() => handleSaveVideoLink(v)}
                                  className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2.5 text-xs font-black uppercase tracking-wider text-white transition ${
                                    isDirty
                                      ? "bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 shadow-glow-cyan"
                                      : "bg-gradient-to-r from-cyan-600 to-indigo-600 hover:brightness-110"
                                  }`}
                                >
                                  <Save className="h-3.5 w-3.5" />
                                  <span>
                                    {savingVideoId === v.id
                                      ? "..."
                                      : isDirty
                                      ? "Save*"
                                      : "Save"}
                                  </span>
                                </button>

                                {(currentDraft.trim() || v.embedUrl) && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const parsed = buildYoutubeEmbedUrl(
                                        currentDraft.trim() || v.embedUrl || ""
                                      );
                                      setPreviewEmbed({
                                        title: v.title,
                                        embedUrl: parsed.embedUrl,
                                      });
                                    }}
                                    title="Live Preview Video"
                                    className="rounded-xl border border-purple-400/40 bg-purple-500/15 p-2.5 text-purple-200 hover:bg-purple-500/25"
                                  >
                                    <Play className="h-3.5 w-3.5 fill-current" />
                                  </button>
                                )}

                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => handleMoveNode(v.id, "UP")}
                                  title="Move Up"
                                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-25"
                                >
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    idx === videosInCurrentLevel.length - 1
                                  }
                                  onClick={() => handleMoveNode(v.id, "DOWN")}
                                  title="Move Down"
                                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-25"
                                >
                                  <ArrowDown className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEditNodeModal({
                                      open: true,
                                      nodeId: v.id,
                                      nodeType: "VIDEO",
                                      title: v.title,
                                      thumbnail: v.thumbnail,
                                      uploadedAt: v.uploadedAt,
                                      link: "",
                                    })
                                  }
                                  title="Edit Lecture Title / Thumbnail"
                                  className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-cyan-300"
                                >
                                  <Edit3 className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteNode(v)}
                                  title="Delete Video"
                                  className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* SECTION C: PDFs & EXTERNAL LINKS IN THIS FOLDER */}
                {otherItemsInCurrentLevel.length > 0 && (
                  <div className="space-y-3">
                    <h2 className="px-1 text-xs font-black uppercase tracking-widest text-rose-300">
                      📄 PDFs & External Links in &ldquo;{folderTitle}&rdquo; (
                      {otherItemsInCurrentLevel.length})
                    </h2>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      {otherItemsInCurrentLevel.map((item) => (
                        <div
                          key={item.id}
                          className="glass-card flex items-center justify-between gap-3 rounded-2xl border border-white/10 p-3.5"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/20 text-rose-300">
                              <FileText className="h-5 w-5" />
                            </div>
                            <div className="min-w-0">
                              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-black text-slate-300">
                                {item.type}
                              </span>
                              <p className="mt-0.5 truncate text-sm font-bold text-white">
                                {item.title}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() =>
                                setEditNodeModal({
                                  open: true,
                                  nodeId: item.id,
                                  nodeType: item.type,
                                  title: item.title,
                                  thumbnail: item.thumbnail,
                                  uploadedAt: item.uploadedAt,
                                  link: item.link || "",
                                })
                              }
                              className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-cyan-300"
                            >
                              <Edit3 className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteNode(item)}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Empty Folder Prompt */}
                {foldersInCurrentLevel.length === 0 &&
                  videosInCurrentLevel.length === 0 &&
                  otherItemsInCurrentLevel.length === 0 && (
                    <div className="glass-card rounded-3xl border border-dashed border-white/20 p-10 text-center">
                      <Folder className="mx-auto mb-3 h-10 w-10 text-cyan-300/60" />
                      <h3 className="text-base font-black text-white">
                        This Folder is Currently Empty
                      </h3>
                      <p className="mt-1 text-xs text-slate-400">
                        Use the <strong>+ Folder</strong> or{" "}
                        <strong>+ Video</strong> buttons above to add content
                        here!
                      </p>
                    </div>
                  )}
              </>
            )}
          </div>
        )}

        {/* ====================================================================
            TAB 2: TELEGRAM SYNC STUDIO (ADD NEW COURSE / JSON MERGE / BOTH)
           ==================================================================== */}
        {activeTab === "TELEGRAM" && (
          <div className="space-y-6">
            {/* Top Status & Encrypted Credentials Vault */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <form
                onSubmit={handleSaveTelegramCredentials}
                className="glass-card space-y-4 rounded-3xl border border-cyan-400/30 p-6 lg:col-span-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-cyan-300" />
                    <h2 className="text-base font-black text-white">
                      1. Telegram Session Vault (AES-256)
                    </h2>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase ${
                      tgConfigured
                        ? "bg-emerald-500/20 text-emerald-300 border border-emerald-400/40"
                        : "bg-amber-500/20 text-amber-300 border border-amber-400/40"
                    }`}
                  >
                    {tgConfigured
                      ? `● Connected (${tgMaskedApiId || "Vault Active"})`
                      : "● Not Configured Yet"}
                  </span>
                </div>

                <p className="text-xs leading-relaxed text-slate-300">
                  Sirf ek baar apna{" "}
                  <strong className="text-cyan-200">
                    API ID, API Hash aur Session String
                  </strong>{" "}
                  save karein. Server ise{" "}
                  <strong>AES-256-GCM Encrypt</strong> karke private vault me
                  rakhta hai — browser me dobara kabhi wapas nahi bhejta!
                </p>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-[11px] font-bold text-slate-300">
                      Telegram API ID
                    </label>
                    <input
                      type="text"
                      value={tgApiId}
                      onChange={(e) => setTgApiId(e.target.value)}
                      placeholder={
                        tgConfigured ? "Saved (enter to update)" : "e.g. 24819201"
                      }
                      className="w-full rounded-xl border border-white/15 bg-[#060919] px-3 py-2.5 text-xs font-semibold text-white outline-none focus:border-cyan-400"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-bold text-slate-300">
                      Telegram API Hash
                    </label>
                    <input
                      type="password"
                      value={tgApiHash}
                      onChange={(e) => setTgApiHash(e.target.value)}
                      placeholder={
                        tgConfigured
                          ? "••••••••••••••••"
                          : "32-char API Hash"
                      }
                      className="w-full rounded-xl border border-white/15 bg-[#060919] px-3 py-2.5 text-xs font-semibold text-white outline-none focus:border-cyan-400"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-bold text-slate-300">
                    Telegram Session String (For Group Scan & Private Sync)
                  </label>
                  <textarea
                    rows={3}
                    value={tgSessionString}
                    onChange={(e) => setTgSessionString(e.target.value)}
                    placeholder={
                      tgConfigured
                        ? "Session String saved in Vault! Paste new string if updating..."
                        : "Paste your 1... Session String from session.py here"
                    }
                    className="w-full rounded-xl border border-white/15 bg-[#060919] p-3 font-mono text-[11px] text-cyan-200 outline-none focus:border-cyan-400"
                  />
                </div>

                <div>
                  <label className="mb-1 flex items-center justify-between text-[11px] font-bold text-emerald-300">
                    <span>
                      Optional @BotFather Bot Token (100% Prevents
                      AUTH_KEY_DUPLICATED on Vercel!)
                    </span>
                    {tgBotConfigured && (
                      <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-black text-emerald-300">
                        BOT ACTIVE
                      </span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={tgBotToken}
                    onChange={(e) => setTgBotToken(e.target.value)}
                    placeholder={
                      tgBotConfigured
                        ? "Bot Token encrypted & active! Paste to change..."
                        : "Optional: 123456789:ABCdef... (Recommended for public/own channels!)"
                    }
                    className="w-full rounded-xl border border-emerald-400/25 bg-[#060919] px-3 py-2.5 text-xs font-semibold text-white outline-none focus:border-emerald-400"
                  />
                </div>

                <button
                  type="submit"
                  disabled={savingTgCreds}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-500 to-indigo-600 py-3 text-xs font-black uppercase tracking-wider text-white transition hover:brightness-110 disabled:opacity-60"
                >
                  {savingTgCreds ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Verifying & Encrypting...</span>
                    </>
                  ) : (
                    <>
                      <Lock className="h-4 w-4" />
                      <span>Verify & Save Session Vault</span>
                    </>
                  )}
                </button>
              </form>

              {/* Group Course Builder & JSON Merger Card */}
              <div className="glass-card space-y-4 rounded-3xl border border-purple-400/35 p-6 lg:col-span-7">
                <div className="flex items-center gap-2">
                  <Send className="h-5 w-5 text-purple-300" />
                  <h2 className="text-base font-black text-white">
                    2. Sync Telegram Group ➔ Auto Folders & JSON Merge
                  </h2>
                </div>

                <p className="text-xs leading-relaxed text-slate-300">
                  Group ke saare bikhre hue Videos aur PDFs ke captions padhkar
                  apne aap <strong>Subject ➔ Chapter ➔ Part-1, Part-2</strong>{" "}
                  folders banata hai ya aapke uploaded JSON course me deep
                  matching karke link jod deta hai!
                </p>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs font-bold text-cyan-300">
                      Telegram Group / Channel Username OR Chat ID (-100...)
                    </label>
                    <input
                      type="text"
                      value={tgChatInput}
                      onChange={(e) => setTgChatInput(e.target.value)}
                      placeholder="e.g. @your_public_group OR https://t.me/groupname OR -100198273645"
                      className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none focus:border-cyan-400"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-bold text-slate-300">
                      Optional Custom Course Title (For New Course)
                    </label>
                    <input
                      type="text"
                      value={tgCustomTitle}
                      onChange={(e) => setTgCustomTitle(e.target.value)}
                      placeholder="Auto-detected from Caption 'Batch:' if blank"
                      className="w-full rounded-xl border border-white/15 bg-[#060919] px-3 py-2 text-xs font-semibold text-white outline-none focus:border-purple-400"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-bold text-slate-300">
                      Target JSON Course (For JSON Merge)
                    </label>
                    <select
                      value={tgTargetBatchId}
                      onChange={(e) => setTgTargetBatchId(e.target.value)}
                      className="w-full rounded-xl border border-white/15 bg-[#060919] px-3 py-2 text-xs font-semibold text-white outline-none focus:border-purple-400"
                    >
                      <option value="AUTO">
                        Auto-Match Across All JSON Courses
                      </option>
                      {batches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} (ID: {b.id})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-bold text-slate-300">
                      Display Price Badge (₹)
                    </label>
                    <input
                      type="text"
                      value={tgCustomPrice}
                      onChange={(e) => setTgCustomPrice(e.target.value)}
                      placeholder="e.g. 999 or 0 for FREE"
                      className="w-full rounded-xl border border-white/15 bg-[#060919] px-3 py-2 text-xs font-semibold text-white outline-none"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-bold text-slate-300">
                      Max Messages to Scan
                    </label>
                    <input
                      type="number"
                      min={50}
                      max={5000}
                      value={tgMessageLimit}
                      onChange={(e) => setTgMessageLimit(e.target.value)}
                      className="w-full rounded-xl border border-white/15 bg-[#060919] px-3 py-2 text-xs font-semibold text-white outline-none"
                    />
                  </div>
                </div>

                {tgSyncStatusMsg && (
                  <div
                    className={`rounded-2xl border p-3.5 text-xs font-bold ${
                      tgSyncStatusMsg.ok
                        ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                        : "border-rose-400/40 bg-rose-500/15 text-rose-200"
                    }`}
                  >
                    {tgSyncStatusMsg.text}
                  </div>
                )}

                {/* ALL 3 REQUESTED SYNC MODE BUTTONS */}
                <div className="grid grid-cols-1 gap-2.5 pt-1 sm:grid-cols-3">
                  <button
                    type="button"
                    disabled={tgSyncing}
                    onClick={() => handleRunTelegramSync("ADD_NEW")}
                    className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-cyan-400/50 bg-cyan-500/20 p-3 text-center transition hover:bg-cyan-500/30 disabled:opacity-50"
                  >
                    <span className="text-xs font-black uppercase text-cyan-200">
                      ➕ Add New Course
                    </span>
                    <span className="text-[10px] font-semibold text-slate-300">
                      Separate Auto-Folder Batch
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={tgSyncing}
                    onClick={() => handleRunTelegramSync("MERGE_JSON")}
                    className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-purple-400/50 bg-purple-500/20 p-3 text-center transition hover:bg-purple-500/30 disabled:opacity-50"
                  >
                    <span className="text-xs font-black uppercase text-purple-200">
                      🔗 JSON Merge Only
                    </span>
                    <span className="text-[10px] font-semibold text-slate-300">
                      Attach Links in Existing JSON
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={tgSyncing}
                    onClick={() => handleRunTelegramSync("BOTH")}
                    className="flex flex-col items-center justify-center gap-1 rounded-2xl bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-600 p-3 text-center text-slate-950 transition hover:brightness-110 disabled:opacity-50"
                  >
                    <span className="text-xs font-black uppercase">
                      ⚡ Add + JSON Merge
                    </span>
                    <span className="text-[10px] font-extrabold opacity-85">
                      Run Both Together!
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* ============================================================
                SYNCED TELEGRAM GROUPS — HAR SYNC KE BAAD YAHAN DIKHEGA
                (ADD_NEW / MERGE_JSON / BOTH — koi bhi mode ho)
               ============================================================ */}
            <div className="glass-card rounded-3xl border border-white/10 p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-black uppercase tracking-wider text-cyan-300">
                  Synced Telegram Groups ({syncedGroups.length}) — 1-Click
                  Update for Daily Uploads
                </h3>
                <span className="rounded-full border border-emerald-400/35 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-emerald-300">
                  Har sync yahan save hota hai
                </span>
              </div>

              {syncedGroups.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-6 text-center">
                  <p className="text-xs font-bold text-slate-300">
                    Abhi koi Telegram group sync nahi hua.
                  </p>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                    Upar Box 2 me group username (jaise{" "}
                    <code className="text-cyan-300">@dishaextractorr</code>) ya
                    Group ID (-100...) daal kar <strong>Add New Course</strong>,{" "}
                    <strong>JSON Merge</strong> ya <strong>Add + JSON Merge</strong>{" "}
                    dabayein — sync hote hi wo group yahin list me aa jayega,
                    jahan se aap kabhi bhi <em>Re-sync</em>, <em>Course delete</em>{" "}
                    ya <em>Record remove</em> kar sakte hain.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {syncedGroups.map((g) => {
                    const statusTone =
                      g.syncStatus === "error"
                        ? "border-rose-400/40 bg-rose-500/15 text-rose-200"
                        : g.syncStatus === "partial"
                        ? "border-amber-400/40 bg-amber-500/15 text-amber-200"
                        : "border-emerald-400/40 bg-emerald-500/15 text-emerald-200";
                    const statusLabel =
                      g.syncStatus === "error"
                        ? "ERROR"
                        : g.syncStatus === "partial"
                        ? "PARTIAL"
                        : "SAVED";

                    return (
                      <div
                        key={g.id}
                        className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-extrabold text-white">
                                {g.title}
                              </span>
                              <span className="rounded bg-cyan-500/15 px-2 py-0.5 text-[10px] font-black text-cyan-300">
                                {g.syncMode}
                              </span>
                              <span
                                className={`rounded border px-2 py-0.5 text-[10px] font-black ${statusTone}`}
                              >
                                {statusLabel}
                              </span>
                            </div>
                            <p className="mt-1 text-[11px] text-slate-400">
                              @{g.chatInput.replace(/^@/, "")} • {g.videosSynced}{" "}
                              Videos • {g.pdfsSynced} PDFs
                              {g.youtubeOnlyCount
                                ? ` • ${g.youtubeOnlyCount} YouTube`
                                : ""}
                              {g.mergedVideosCount || g.mergedPdfsCount
                                ? ` • Merged ${g.mergedVideosCount || 0}V/${
                                    g.mergedPdfsCount || 0
                                  }P`
                                : ""}{" "}
                              • Last Sync:{" "}
                              {new Date(g.lastSyncedAt).toLocaleString()}
                            </p>
                            {g.lastSyncMessage && (
                              <p className="mt-1.5 max-w-2xl rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-[10px] leading-relaxed text-slate-300">
                                {g.lastSyncMessage}
                              </p>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={tgSyncing}
                              onClick={() => handleRunTelegramSync(g.syncMode, g)}
                              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/45 bg-emerald-500/15 px-3.5 py-2 text-xs font-black text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
                            >
                              <RefreshCw
                                className={`h-3.5 w-3.5 ${
                                  tgSyncing ? "animate-spin" : ""
                                }`}
                              />
                              <span>Re-Sync</span>
                            </button>

                            {g.createdBatchId && (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setSelectedBatchId(g.createdBatchId as string)
                                  }
                                  className="rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-3 py-2 text-xs font-black text-cyan-200 hover:bg-cyan-500/25"
                                >
                                  Open Course
                                </button>
                                <button
                                  type="button"
                                  disabled={tgSyncing}
                                  onClick={() => handleDeleteSyncedCourse(g)}
                                  className="rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-xs font-black text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                                  title="JSON se ye course hata dein"
                                >
                                  Delete Course
                                </button>
                              </>
                            )}

                            <button
                              type="button"
                              onClick={() => handleDeleteSyncedGroup(g.id)}
                              className="rounded-xl border border-rose-400/35 bg-rose-500/15 p-2 text-rose-300 hover:bg-rose-500/25"
                              title="List se record hatayein"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ====================================================================
            TAB 3: ALL COURSES STUDIO (REORDER #1..N / ⭐ IMPORTANT / UPLOAD / EDIT)
           ==================================================================== */}
        {activeTab === "COURSES" && (
          <div className="space-y-6">
            <div className="glass-card flex flex-col justify-between gap-4 rounded-3xl border border-cyan-400/30 p-6 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-lg font-black text-white">
                  Full Course & Position Studio
                </h2>
                <p className="mt-1 text-xs text-slate-300">
                  Kisi bhi course par{" "}
                  <strong className="text-amber-300">⭐ Important</strong>{" "}
                  lagayein (hamesha #1 top par rahega) ya{" "}
                  <strong className="text-cyan-300">#1, #2, #3 / ↑ ↓</strong> se
                  apne hisab se upar-neeche set karein!
                </p>
              </div>

              <div className="flex flex-wrap gap-2.5">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl bg-gradient-to-r from-cyan-400 via-sky-500 to-indigo-600 px-4 py-3 text-xs font-black uppercase tracking-wider text-slate-950 shadow-glow-cyan transition hover:brightness-110">
                  <Upload className="h-4 w-4" />
                  <span>Import .JSON File(s)</span>
                  <input
                    type="file"
                    accept=".json,application/json"
                    multiple
                    onChange={handleJsonFilesUpload}
                    className="hidden"
                  />
                </label>

                <button
                  type="button"
                  onClick={() =>
                    setCreateBatchModal({
                      open: true,
                      name: "",
                      price: "999",
                      thumbnail: "",
                    })
                  }
                  className="inline-flex items-center gap-2 rounded-2xl border border-purple-400/50 bg-purple-500/20 px-4 py-3 text-xs font-black uppercase tracking-wider text-purple-100 shadow-glow-purple transition hover:bg-purple-500/30"
                >
                  <Plus className="h-4 w-4" />
                  <span>Create Blank Course</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {batches.map((b, idx) => {
                const pct =
                  b.totalVideos > 0
                    ? Math.round((b.linkedVideos / b.totalVideos) * 100)
                    : 0;
                return (
                  <div
                    key={b.id}
                    className={`glass-card flex flex-col justify-between rounded-3xl border p-4 ${
                      b.important
                        ? "border-amber-400/65 bg-amber-500/[0.04]"
                        : b.hidden
                        ? "border-amber-400/35 opacity-80"
                        : "border-white/10"
                    }`}
                  >
                    <div className="flex gap-3.5">
                      <div className="relative h-20 w-32 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-[#0b0f26]">
                        <SafeImage
                          src={b.thumbnail}
                          fallbackSrc={config.defaultImageUrl}
                          alt={b.name}
                          className="h-full w-full object-cover"
                        />
                        <span className="absolute left-1.5 top-1.5 rounded-md bg-black/80 px-1.5 py-0.5 text-[10px] font-black text-cyan-300">
                          #{idx + 1}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {b.important && (
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-black text-slate-950">
                              <Star className="h-2.5 w-2.5 fill-slate-950" />
                              IMPORTANT TOP
                            </span>
                          )}
                          <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-black text-amber-300">
                            {b.displayPrice}
                          </span>
                          <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-mono text-slate-300">
                            ID: {b.id}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-black ${
                              b.hidden
                                ? "bg-amber-500/20 text-amber-300"
                                : "bg-emerald-500/20 text-emerald-300"
                            }`}
                          >
                            {b.hidden ? "🙈 Hidden" : "👁️ Published"}
                          </span>
                        </div>
                        <h3 className="mt-1.5 line-clamp-2 text-base font-extrabold text-white">
                          {b.name}
                        </h3>
                        <p className="mt-1 text-xs font-semibold text-slate-400">
                          {b.totalFolders} Folders • {b.linkedVideos}/
                          {b.totalVideos} Videos Linked ({pct}%) • {b.totalPdfs}{" "}
                          PDFs
                        </p>
                      </div>
                    </div>

                    {/* Position & ⭐ Important Pin Row */}
                    <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/10 bg-[#060919]/75 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            handleSetBatchPositionPrompt(b, idx + 1)
                          }
                          title="Set exact position number (1, 2, 3...)"
                          className="rounded-lg border border-cyan-400/40 bg-cyan-500/15 px-2.5 py-1 text-[11px] font-black text-cyan-200 hover:bg-cyan-500/25"
                        >
                          #{idx + 1} Set Rank
                        </button>

                        <button
                          type="button"
                          onClick={() => handleToggleBatchImportant(b)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-black transition ${
                            b.important
                              ? "border-amber-400 bg-amber-400 text-slate-950"
                              : "border-amber-400/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                          }`}
                        >
                          <Star
                            className={`h-3 w-3 ${
                              b.important ? "fill-slate-950" : ""
                            }`}
                          />
                          <span>
                            {b.important ? "Important ON" : "Mark Important"}
                          </span>
                        </button>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => handleReorderBatch(b.id, "TOP")}
                          title="Move Course to Very Top (#1)"
                          className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-200 hover:bg-white/15 disabled:opacity-25"
                        >
                          <ChevronsUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => handleReorderBatch(b.id, "UP")}
                          title="Move Course Up"
                          className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-200 hover:bg-white/15 disabled:opacity-25"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === batches.length - 1}
                          onClick={() => handleReorderBatch(b.id, "DOWN")}
                          title="Move Course Down"
                          className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-200 hover:bg-white/15 disabled:opacity-25"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === batches.length - 1}
                          onClick={() => handleReorderBatch(b.id, "BOTTOM")}
                          title="Move Course to Very Bottom"
                          className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-200 hover:bg-white/15 disabled:opacity-25"
                        >
                          <ChevronsDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Action Bar */}
                    <div className="mt-3 flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => openCourseInExplorer(b.id)}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-cyan-500/25 to-indigo-500/25 border border-cyan-400/40 px-3 py-2 text-xs font-extrabold text-cyan-200 hover:bg-cyan-500/35"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        <span>Open Folders</span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          setEditBatchModal({
                            id: b.id,
                            name: b.name,
                            price: b.rawPrice || "0",
                            thumbnail: b.thumbnail,
                            hidden: b.hidden,
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-white/10"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                        <span>Edit Info</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleToggleBatchHidden(b)}
                        className="inline-flex items-center gap-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-white/10"
                      >
                        {b.hidden ? (
                          <>
                            <Eye className="h-3.5 w-3.5 text-emerald-300" />
                            <span>Publish</span>
                          </>
                        ) : (
                          <>
                            <EyeOff className="h-3.5 w-3.5 text-amber-300" />
                            <span>Hide</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleOpenRawJson(b)}
                        title="View / Edit Raw JSON"
                        className="inline-flex items-center gap-1 rounded-xl border border-purple-400/35 bg-purple-500/15 px-3 py-2 text-xs font-bold text-purple-200 hover:bg-purple-500/25"
                      >
                        <Code2 className="h-3.5 w-3.5" />
                        <span>JSON</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDownloadBatchJson(b)}
                        title="Download .json backup"
                        className="rounded-xl border border-white/15 bg-white/5 p-2 text-slate-300 hover:text-cyan-300"
                      >
                        <Download className="h-3.5 w-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteBatch(b)}
                        title="Delete Course"
                        className="ml-auto rounded-xl border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300 hover:bg-rose-500/25"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ====================================================================
            TAB 3: ANALYTICS OVERVIEW
           ==================================================================== */}
        {activeTab === "OVERVIEW" && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <div className="glass-card rounded-3xl border border-cyan-400/25 p-5">
                <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                  Total Courses
                </p>
                <p className="mt-1 text-3xl font-black text-cyan-300">
                  {stats.totalBatches}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {stats.totalBatches - stats.hiddenBatches} Live •{" "}
                  {stats.hiddenBatches} Hidden
                </p>
              </div>

              <div className="glass-card rounded-3xl border border-purple-400/25 p-5">
                <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                  YouTube Link Coverage
                </p>
                <p className="mt-1 text-3xl font-black text-purple-300">
                  {coveragePct}%
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {stats.linkedVideos} of {stats.totalVideos} Videos Linked
                </p>
              </div>

              <div className="glass-card rounded-3xl border border-indigo-400/25 p-5">
                <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                  Folders & PDFs
                </p>
                <p className="mt-1 text-3xl font-black text-indigo-300">
                  {stats.totalFolders}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Folders • {stats.totalPdfs} PDF Notes
                </p>
              </div>

              <div className="glass-card rounded-3xl border border-emerald-400/25 p-5">
                <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                  Captured Logins
                </p>
                <p className="mt-1 text-3xl font-black text-emerald-300">
                  {stats.savedLogins}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  100% Private Vault
                </p>
              </div>
            </div>

            {/* Course-by-Course Progress Table */}
            <div className="glass-card rounded-3xl border border-white/10 p-6">
              <h2 className="mb-4 text-base font-black text-white">
                Course Video Link Progress
              </h2>
              <div className="space-y-4">
                {batches.map((b) => {
                  const pct =
                    b.totalVideos > 0
                      ? Math.round((b.linkedVideos / b.totalVideos) * 100)
                      : 100;
                  return (
                    <div
                      key={b.id}
                      className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between text-xs font-extrabold text-white">
                          <span className="truncate">{b.name}</span>
                          <span className="ml-2 shrink-0 text-cyan-300">
                            {b.linkedVideos} / {b.totalVideos} Videos ({pct}%)
                          </span>
                        </div>
                        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-emerald-400 transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => openCourseInExplorer(b.id)}
                        className="shrink-0 rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-4 py-2 text-xs font-black uppercase text-cyan-200 hover:bg-cyan-500/25"
                      >
                        Manage Folders →
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ====================================================================
            TAB 4: WEBSITE CONTROLS & .ENV SECURITY GUIDE
           ==================================================================== */}
        {activeTab === "SETTINGS" && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <form
              onSubmit={handleSaveSiteSettings}
              className="glass-card space-y-4 rounded-3xl border border-white/10 p-6 lg:col-span-7"
            >
              <h2 className="text-lg font-black text-white">
                Live Website & Popup Controls
              </h2>

              {/* Announcement Banner */}
              <div className="rounded-2xl border border-cyan-400/25 bg-cyan-500/5 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black uppercase tracking-wider text-cyan-300">
                    Top Announcement Banner (Home Page)
                  </span>
                  <input
                    type="checkbox"
                    checked={announcementEnabled}
                    onChange={(e) => setAnnouncementEnabled(e.target.checked)}
                    className="h-4 w-4 accent-cyan-400"
                  />
                </div>
                <input
                  type="text"
                  value={announcementText}
                  onChange={(e) => setAnnouncementText(e.target.value)}
                  placeholder="e.g. 🔥 New 12th Physics & Spoken English Lectures Uploaded!"
                  className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none focus:border-cyan-400"
                />
              </div>

              {/* Telegram Popup Controls */}
              <div className="rounded-2xl border border-purple-400/25 bg-purple-500/5 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black uppercase tracking-wider text-purple-300">
                    Telegram Daily Upload Popup (After Login)
                  </span>
                  <input
                    type="checkbox"
                    checked={telegramPopupEnabled}
                    onChange={(e) => setTelegramPopupEnabled(e.target.checked)}
                    className="h-4 w-4 accent-purple-400"
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-[11px] font-bold text-slate-300">
                      Telegram Channel Link
                    </label>
                    <input
                      type="url"
                      value={telegramJoinUrl}
                      onChange={(e) => setTelegramJoinUrl(e.target.value)}
                      className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none focus:border-purple-400"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-bold text-slate-300">
                      Auto-Close (Sec)
                    </label>
                    <input
                      type="number"
                      min={2}
                      max={60}
                      value={telegramAutoCloseSeconds}
                      onChange={(e) =>
                        setTelegramAutoCloseSeconds(Number(e.target.value) || 5)
                      }
                      className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none focus:border-purple-400"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-bold text-slate-300">
                    Popup Title
                  </label>
                  <input
                    type="text"
                    value={telegramPopupTitle}
                    onChange={(e) => setTelegramPopupTitle(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2 text-xs font-semibold text-white outline-none"
                  />
                </div>
              </div>

              {/* Images & Fallback Video */}
              <div>
                <label className="mb-1 block text-xs font-bold text-cyan-300">
                  Default Fallback Image URL (Jab JSON me image na ho)
                </label>
                <input
                  type="url"
                  value={defaultImageUrl}
                  onChange={(e) => setDefaultImageUrl(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none focus:border-cyan-400"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-bold text-cyan-300">
                  App Logo URL
                </label>
                <input
                  type="url"
                  value={appLogoUrl}
                  onChange={(e) => setAppLogoUrl(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none focus:border-cyan-400"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-bold text-purple-300">
                  Optional Global Default YouTube Link
                </label>
                <input
                  type="text"
                  value={defaultYoutubeUrl}
                  onChange={(e) => setDefaultYoutubeUrl(e.target.value)}
                  placeholder="Leave empty or paste fallback YouTube URL..."
                  className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none focus:border-purple-400"
                />
              </div>

              {/* Cloudflare Edge Worker + Video Download Controls */}
              <div className="rounded-2xl border border-emerald-400/25 bg-emerald-500/5 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black uppercase tracking-wider text-emerald-300">
                    Allow Students to Download Videos (Free)
                  </span>
                  <input
                    type="checkbox"
                    checked={allowVideoDownload}
                    onChange={(e) => setAllowVideoDownload(e.target.checked)}
                    className="h-4 w-4 accent-emerald-400"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-bold text-slate-300">
                    Optional Cloudflare Stream Worker URL (For 200–300 Users
                    Free Edge Caching)
                  </label>
                  <input
                    type="url"
                    value={cloudflareStreamWorkerUrl}
                    onChange={(e) =>
                      setCloudflareStreamWorkerUrl(e.target.value)
                    }
                    placeholder="Leave blank for Direct Vercel 2MB Chunk Stream, or https://your-worker.workers.dev"
                    className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none focus:border-emerald-400"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full rounded-2xl bg-gradient-to-r from-cyan-500 via-indigo-600 to-purple-600 py-3.5 text-xs font-black uppercase tracking-widest text-white shadow-glow-cyan transition hover:brightness-110"
              >
                Save All Website Settings
              </button>
            </form>

            {/* .ENV Security Guide Card */}
            <div className="glass-card space-y-4 rounded-3xl border border-emerald-400/30 p-6 lg:col-span-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Lock className="h-5 w-5 text-emerald-400" />
                  <h2 className="text-lg font-black text-white">
                    Firebase Realtime DB & .env Vault
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={handleTestDbConnection}
                  disabled={testingDb}
                  className="rounded-xl border border-cyan-400/45 bg-cyan-500/20 px-3 py-1.5 text-[11px] font-black uppercase tracking-wider text-cyan-200 transition hover:bg-cyan-500/30 disabled:opacity-50"
                >
                  {testingDb ? "Testing..." : "⚡ Test DB Connection"}
                </button>
              </div>

              {(dbTestBanner || lastDbError) && (
                <div
                  className={`rounded-2xl border p-3.5 text-xs font-semibold ${
                    dbTestBanner
                      ? dbTestBanner.ok
                        ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                        : "border-rose-400/40 bg-rose-500/15 text-rose-200"
                      : "border-amber-400/40 bg-amber-500/15 text-amber-200"
                  }`}
                >
                  {dbTestBanner ? dbTestBanner.message : lastDbError}
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black uppercase tracking-wider text-cyan-300">
                    1. Realtime Database Rules (JSON Format)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(
                        `{\n  "rules": {\n    ".read": false,\n    ".write": false\n  }\n}`
                      );
                      showToast("Realtime Database JSON Rules Copied!");
                    }}
                    className="rounded-lg border border-white/15 bg-white/10 px-2.5 py-1 text-[10px] font-black uppercase text-white hover:bg-white/20"
                  >
                    Copy JSON Rules
                  </button>
                </div>
                <pre className="rounded-2xl border border-white/10 bg-[#050816] p-3 font-mono text-[11px] text-emerald-300 overflow-x-auto">{`{
  "rules": {
    ".read": false,
    ".write": false
  }
}`}</pre>
              </div>

              <div className="space-y-2">
                <span className="text-xs font-black uppercase tracking-wider text-purple-300">
                  2. Required Server Environment Variable Keys
                </span>
                <div className="rounded-2xl border border-white/10 bg-[#050816] p-3.5 font-mono text-[11px] leading-relaxed text-cyan-200 overflow-x-auto">
                  <div>ADMIN_EMAIL=&lt;set-in-vercel-env&gt;</div>
                  <div>ADMIN_PASSWORD=&lt;set-in-vercel-env&gt;</div>
                  <div>ADMIN_SESSION_SECRET=&lt;set-in-vercel-env&gt;</div>
                  <div className="mt-2 text-slate-400">
                    # Firebase Service Account Keys (Server-Only)
                  </div>
                  <div>FIREBASE_PROJECT_ID=&lt;set-in-vercel-env&gt;</div>
                  <div>FIREBASE_DATABASE_URL=&lt;set-in-vercel-env&gt;</div>
                  <div>FIREBASE_CLIENT_EMAIL=&lt;set-in-vercel-env&gt;</div>
                  <div>FIREBASE_PRIVATE_KEY=&lt;set-in-vercel-env&gt;</div>
                </div>
              </div>

              <div className="rounded-2xl border border-emerald-400/25 bg-emerald-500/10 p-3.5 text-xs text-emerald-200">
                <strong>Zero-Crash Protection Active:</strong> Aapka{" "}
                <code>Realtime Database</code> <code>.read: false</code> aur{" "}
                <code>.write: false</code> rules ke saath 100% private rehta hai
                aur sirf aapka Vercel backend server Service Account se usme data
                save aur read karta hai!
              </div>
            </div>
          </div>
        )}

        {/* ====================================================================
            TAB 5: SAVED STUDENT LOGINS VAULT
           ==================================================================== */}
        {activeTab === "LOGINS" && (
          <div className="glass-card rounded-3xl border border-white/10 p-5 sm:p-6">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-black text-white">
                  Saved Student Logins ({filteredLogins.length})
                </h2>
                <p className="text-xs text-slate-400">
                  Students jo login form me ID/Mobile aur Password daalte hain,
                  wo private taur par yahan save hota hai.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={loginSearch}
                  onChange={(e) => setLoginSearch(e.target.value)}
                  placeholder="Search Mobile / ID..."
                  className="rounded-xl border border-white/15 bg-[#060919] px-3 py-2 text-xs font-semibold text-white outline-none focus:border-cyan-400"
                />
                <button
                  type="button"
                  onClick={() => setRevealPasswords((s) => !s)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-white/10"
                >
                  {revealPasswords ? (
                    <>
                      <EyeOff className="h-3.5 w-3.5" />
                      <span>Mask</span>
                    </>
                  ) : (
                    <>
                      <Eye className="h-3.5 w-3.5" />
                      <span>Reveal</span>
                    </>
                  )}
                </button>
                {loginsList.length > 0 && (
                  <button
                    type="button"
                    onClick={exportLoginsCsv}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/40 bg-emerald-500/20 px-3 py-2 text-xs font-extrabold text-emerald-200"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Export CSV</span>
                  </button>
                )}
              </div>
            </div>

            {filteredLogins.length === 0 ? (
              <p className="py-10 text-center text-sm text-slate-400">
                No student logins recorded yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/10 text-slate-400">
                      <th className="py-2.5 pr-4">Mobile / User ID</th>
                      <th className="py-2.5 pr-4">Password</th>
                      <th className="py-2.5 pr-4">IP</th>
                      <th className="py-2.5 pr-4">Time</th>
                      <th className="py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filteredLogins.map((row, idx) => (
                      <tr key={row.id || idx} className="text-slate-200">
                        <td className="py-3 pr-4 font-bold text-cyan-300">
                          {row.userId}
                        </td>
                        <td className="py-3 pr-4 font-mono">
                          {revealPasswords ? row.password : "••••••••••"}
                        </td>
                        <td className="py-3 pr-4 text-slate-400">
                          {row.ip || "-"}
                        </td>
                        <td className="py-3 pr-4 text-slate-400">
                          {row.createdAt
                            ? new Date(row.createdAt).toLocaleString()
                            : "-"}
                        </td>
                        <td className="py-3 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(
                                  `${row.userId} : ${row.password}`
                                );
                                showToast("Copied credentials");
                              }}
                              title="Copy"
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-cyan-300"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                            {row.id && (
                              <button
                                type="button"
                                onClick={() => handleDeleteLoginEntry(row.id)}
                                title="Delete"
                                className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ======================================================================
          MODALS (VIDEO PREVIEW, ADD FOLDER/VIDEO, EDIT ITEM, CREATE/EDIT COURSE, RAW JSON)
         ====================================================================== */}

      {/* 1. Live Video Embed Preview Modal */}
      {previewEmbed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
          onClick={() => setPreviewEmbed(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl overflow-hidden rounded-3xl border border-cyan-400/40 bg-[#080b1f] shadow-glow-cyan"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <p className="truncate text-xs font-extrabold text-white">
                ▶ Live Preview: {previewEmbed.title}
              </p>
              <button
                type="button"
                onClick={() => setPreviewEmbed(null)}
                className="rounded-lg p-1 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="aspect-video w-full bg-black">
              <iframe
                src={previewEmbed.embedUrl}
                title={previewEmbed.title}
                className="h-full w-full border-0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
              />
            </div>
          </div>
        </div>
      )}

      {/* 2. Add Folder / Video / PDF / Link Modal */}
      {addNodeModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
          onClick={() => setAddNodeModal((p) => ({ ...p, open: false }))}
        >
          <form
            onSubmit={handleAddNodeSubmit}
            onClick={(e) => e.stopPropagation()}
            className="glass-card w-full max-w-md space-y-4 rounded-3xl border border-cyan-400/40 p-6"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-white">
                Add Item Inside &ldquo;{folderTitle}&rdquo;
              </h3>
              <button
                type="button"
                onClick={() => setAddNodeModal((p) => ({ ...p, open: false }))}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-4 gap-1.5">
              {(["FOLDER", "VIDEO", "PDF", "LINK"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() =>
                    setAddNodeModal((p) => ({ ...p, nodeType: t }))
                  }
                  className={`rounded-xl py-2 text-[11px] font-black ${
                    addNodeModal.nodeType === t
                      ? "bg-cyan-500 text-slate-950"
                      : "bg-white/5 text-slate-300"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-300">
                Title *
              </label>
              <input
                type="text"
                required
                value={addNodeModal.title}
                onChange={(e) =>
                  setAddNodeModal((p) => ({ ...p, title: e.target.value }))
                }
                placeholder={
                  addNodeModal.nodeType === "FOLDER"
                    ? "e.g. Chapter 2 - Electrostatics"
                    : "e.g. Lecture 1 - Introduction"
                }
                className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none focus:border-cyan-400"
              />
            </div>

            {addNodeModal.nodeType === "VIDEO" && (
              <div>
                <label className="mb-1 block text-xs font-bold text-cyan-300">
                  YouTube Video Link (Optional now, or paste directly)
                </label>
                <input
                  type="text"
                  value={addNodeModal.youtubeUrl}
                  onChange={(e) =>
                    setAddNodeModal((p) => ({
                      ...p,
                      youtubeUrl: e.target.value,
                    }))
                  }
                  placeholder="https://youtu.be/... or https://www.youtube.com/watch?v=..."
                  className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none focus:border-cyan-400"
                />
              </div>
            )}

            {addNodeModal.nodeType === "LINK" && (
              <div>
                <label className="mb-1 block text-xs font-bold text-emerald-300">
                  External URL (Telegram / WhatsApp / Drive)
                </label>
                <input
                  type="url"
                  value={addNodeModal.link}
                  onChange={(e) =>
                    setAddNodeModal((p) => ({ ...p, link: e.target.value }))
                  }
                  placeholder="https://..."
                  className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none"
                />
              </div>
            )}

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-300">
                Thumbnail Image URL (Blank = Auto Default Placeholder)
              </label>
              <input
                type="text"
                value={addNodeModal.thumbnail}
                onChange={(e) =>
                  setAddNodeModal((p) => ({ ...p, thumbnail: e.target.value }))
                }
                placeholder="Leave blank for default image..."
                className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none"
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-2xl bg-gradient-to-r from-cyan-500 to-purple-600 py-3 text-xs font-black uppercase tracking-widest text-white shadow-glow-cyan"
            >
              Add {addNodeModal.nodeType} Live
            </button>
          </form>
        </div>
      )}

      {/* 3. Edit Folder / Video / Item Modal */}
      {editNodeModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
          onClick={() => setEditNodeModal(null)}
        >
          <form
            onSubmit={handleEditNodeSubmit}
            onClick={(e) => e.stopPropagation()}
            className="glass-card w-full max-w-md space-y-4 rounded-3xl border border-purple-400/40 p-6"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-white">
                Edit {editNodeModal.nodeType}
              </h3>
              <button
                type="button"
                onClick={() => setEditNodeModal(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-300">
                Title
              </label>
              <input
                type="text"
                required
                value={editNodeModal.title}
                onChange={(e) =>
                  setEditNodeModal((p) =>
                    p ? { ...p, title: e.target.value } : null
                  )
                }
                className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-300">
                Thumbnail URL (Blank = Default Image)
              </label>
              <input
                type="text"
                value={editNodeModal.thumbnail}
                onChange={(e) =>
                  setEditNodeModal((p) =>
                    p ? { ...p, thumbnail: e.target.value } : null
                  )
                }
                className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none"
              />
            </div>

            {editNodeModal.nodeType !== "FOLDER" && (
              <div>
                <label className="mb-1 block text-xs font-bold text-slate-300">
                  Upload Date Label
                </label>
                <input
                  type="text"
                  value={editNodeModal.uploadedAt}
                  onChange={(e) =>
                    setEditNodeModal((p) =>
                      p ? { ...p, uploadedAt: e.target.value } : null
                    )
                  }
                  placeholder="e.g. 25-10-2026 at 07:30 pm"
                  className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none"
                />
              </div>
            )}

            <button
              type="submit"
              className="w-full rounded-2xl bg-gradient-to-r from-purple-600 to-cyan-500 py-3 text-xs font-black uppercase tracking-widest text-white"
            >
              Save Changes
            </button>
          </form>
        </div>
      )}

      {/* 4. Create Blank Course Modal */}
      {createBatchModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
          onClick={() => setCreateBatchModal((p) => ({ ...p, open: false }))}
        >
          <form
            onSubmit={handleCreateBatch}
            onClick={(e) => e.stopPropagation()}
            className="glass-card w-full max-w-md space-y-4 rounded-3xl border border-cyan-400/40 p-6"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-white">
                Create New Course / Batch
              </h3>
              <button
                type="button"
                onClick={() =>
                  setCreateBatchModal((p) => ({ ...p, open: false }))
                }
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-300">
                Course Name *
              </label>
              <input
                type="text"
                required
                value={createBatchModal.name}
                onChange={(e) =>
                  setCreateBatchModal((p) => ({ ...p, name: e.target.value }))
                }
                placeholder="e.g. 12th Target Batch 2027"
                className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-300">
                Corner Price Tag (e.g. 999, or 0 for FREE)
              </label>
              <input
                type="text"
                value={createBatchModal.price}
                onChange={(e) =>
                  setCreateBatchModal((p) => ({ ...p, price: e.target.value }))
                }
                className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-300">
                Banner Thumbnail URL (Blank = Default Placeholder)
              </label>
              <input
                type="text"
                value={createBatchModal.thumbnail}
                onChange={(e) =>
                  setCreateBatchModal((p) => ({
                    ...p,
                    thumbnail: e.target.value,
                  }))
                }
                className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none"
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-2xl bg-gradient-to-r from-cyan-500 to-indigo-600 py-3 text-xs font-black uppercase tracking-widest text-white"
            >
              Create Course & Open Folders
            </button>
          </form>
        </div>
      )}

      {/* 5. Edit Course Metadata Modal */}
      {editBatchModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
          onClick={() => setEditBatchModal(null)}
        >
          <form
            onSubmit={handleUpdateBatchMeta}
            onClick={(e) => e.stopPropagation()}
            className="glass-card w-full max-w-md space-y-4 rounded-3xl border border-cyan-400/40 p-6"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-white">
                Edit Course Info
              </h3>
              <button
                type="button"
                onClick={() => setEditBatchModal(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-300">
                Course Name
              </label>
              <input
                type="text"
                required
                value={editBatchModal.name}
                onChange={(e) =>
                  setEditBatchModal((p) =>
                    p ? { ...p, name: e.target.value } : null
                  )
                }
                className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-300">
                Corner Price (Positive number e.g. 999, or 0 for FREE)
              </label>
              <input
                type="text"
                value={editBatchModal.price}
                onChange={(e) =>
                  setEditBatchModal((p) =>
                    p ? { ...p, price: e.target.value } : null
                  )
                }
                className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-bold text-slate-300">
                Thumbnail URL
              </label>
              <input
                type="text"
                value={editBatchModal.thumbnail}
                onChange={(e) =>
                  setEditBatchModal((p) =>
                    p ? { ...p, thumbnail: e.target.value } : null
                  )
                }
                className="w-full rounded-xl border border-white/15 bg-[#060919] px-3.5 py-2.5 text-xs font-semibold text-white outline-none"
              />
            </div>

            <label className="flex items-center gap-2 text-xs font-bold text-amber-300">
              <input
                type="checkbox"
                checked={editBatchModal.hidden}
                onChange={(e) =>
                  setEditBatchModal((p) =>
                    p ? { ...p, hidden: e.target.checked } : null
                  )
                }
                className="h-4 w-4 accent-amber-400"
              />
              <span>Hide this course from students temporarily</span>
            </label>

            <button
              type="submit"
              className="w-full rounded-2xl bg-gradient-to-r from-cyan-500 to-purple-600 py-3 text-xs font-black uppercase tracking-widest text-white"
            >
              Update Course
            </button>
          </form>
        </div>
      )}

      {/* 6. Raw JSON Editor Modal */}
      {rawJsonModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md"
          onClick={() => setRawJsonModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="glass-card flex h-[85vh] w-full max-w-4xl flex-col rounded-3xl border border-purple-400/40 p-5"
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-base font-black text-white">
                  Raw JSON Editor — {rawJsonModal.name}
                </h3>
                <p className="text-[11px] text-slate-400">
                  Direct full JSON view & live editing
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRawJsonModal(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <textarea
              value={rawJsonModal.jsonText}
              onChange={(e) =>
                setRawJsonModal((p) =>
                  p ? { ...p, jsonText: e.target.value } : null
                )
              }
              spellCheck={false}
              className="flex-1 rounded-2xl border border-white/15 bg-[#040612] p-4 font-mono text-xs text-cyan-200 outline-none focus:border-cyan-400"
            />

            <div className="mt-4 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setRawJsonModal(null)}
                className="rounded-xl border border-white/15 px-4 py-2.5 text-xs font-bold text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveRawJson}
                className="rounded-xl bg-gradient-to-r from-cyan-500 to-purple-600 px-6 py-2.5 text-xs font-black uppercase tracking-wider text-white shadow-glow-cyan"
              >
                Save Raw JSON Live
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
