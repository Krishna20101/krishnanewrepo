import fs from "fs";
import path from "path";
import {
  BatchOrderMeta,
  getAllBatchOrderMeta,
  getCustomUploadedBatches,
  getDeletedBatchIds,
  getSingleCustomBatch,
} from "./db";

export interface RawBatchNode {
  id: string | number;
  parent_id?: string | number;
  title?: string;
  name?: string;
  type: "FOLDER" | "VIDEO" | "PDF" | "LINK" | string;
  thumbnail?: string;
  uploaded_at?: string;
  date?: string;
  videos_count?: number;
  files_count?: number;
  children?: RawBatchNode[];
  video_id_enc?: string;
  pdf_link_enc?: string;
  pdf_url?: string;
  link?: string;
  youtube_url?: string;
  tg_video_token?: string;
  tg_pdf_token?: string;
  file_size?: number;
  duration_sec?: number;
  important?: boolean;
  sort_order?: number;
}

export interface RawBatchFile {
  source?: string;
  id?: string | number;
  name?: string;
  title?: string;
  thumbnail?: string;
  price?: string | number;
  slug?: string;
  hidden?: boolean;
  important?: boolean;
  sort_order?: number;
  scraped_at?: string;
  item_count?: number;
  tree?: RawBatchNode[];
  videos?: RawBatchNode[];
}

export interface BatchSummary {
  id: string;
  name: string;
  thumbnail: string;
  rawPrice: string;
  displayPrice: string;
  isFreeTag: boolean;
  hidden: boolean;
  important: boolean;
  sortOrder: number;
  source: string;
  totalFolders: number;
  totalVideos: number;
  linkedVideos: number;
  totalPdfs: number;
  itemCount: number;
}

export interface CleanNodeItem {
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
  hasAttachedPdf: boolean;
  hasRealPdf: boolean;
  link?: string;
  hasSubfolders?: boolean;
  hasYoutubeEmbed?: boolean;
  hasTelegramStream?: boolean;
  rawUrl?: string;
  embedUrl?: string;
  important: boolean;
  sortOrder: number;
  fileSize?: number;
}

export interface BreadcrumbItem {
  id: string;
  title: string;
}

/**
 * Sorts nodes so `important: true` (⭐ Starred) items ALWAYS appear at the top,
 * while preserving Admin custom order (`sort_order` / array index) within groups!
 */
export function sortNodesByImportanceAndOrder(
  nodes: RawBatchNode[] = []
): RawBatchNode[] {
  return nodes
    .map((n, index) => ({ n, index }))
    .sort((a, b) => {
      const impA = a.n.important ? 1 : 0;
      const impB = b.n.important ? 1 : 0;
      if (impA !== impB) return impB - impA;

      const ordA =
        typeof a.n.sort_order === "number" ? a.n.sort_order : 100000 + a.index;
      const ordB =
        typeof b.n.sort_order === "number" ? b.n.sort_order : 100000 + b.index;
      if (ordA !== ordB) return ordA - ordB;

      return a.index - b.index;
    })
    .map((x) => x.n);
}

export function countSubtreeWithLinks(
  nodes: RawBatchNode[] = [],
  embedKeys?: Set<string>,
  batchId?: string
): {
  folders: number;
  videos: number;
  linkedVideos: number;
  pdfs: number;
} {
  let folders = 0;
  let videos = 0;
  let linkedVideos = 0;
  let pdfs = 0;

  for (const node of nodes) {
    const t = String(node.type || "").toUpperCase();
    const nid = String(node.id);
    if (t === "FOLDER") {
      folders += 1;
      const sub = countSubtreeWithLinks(node.children || [], embedKeys, batchId);
      folders += sub.folders;
      videos += sub.videos;
      linkedVideos += sub.linkedVideos;
      pdfs += sub.pdfs;
    } else if (t === "VIDEO") {
      videos += 1;
      const isLinked =
        Boolean(node.youtube_url) ||
        Boolean(node.tg_video_token) ||
        (embedKeys
          ? embedKeys.has(`${batchId}_${nid}`) || embedKeys.has(nid)
          : false);
      if (isLinked) linkedVideos += 1;
      if (node.pdf_link_enc || node.tg_pdf_token || node.pdf_url) pdfs += 1;
    } else if (t === "PDF") {
      pdfs += 1;
    }
  }
  return { folders, videos, linkedVideos, pdfs };
}

export function getEffectiveRootNodes(batch: RawBatchFile): RawBatchNode[] {
  const tree = Array.isArray(batch.tree) ? batch.tree : [];
  if (
    tree.length === 1 &&
    String(tree[0].type || "").toUpperCase() === "FOLDER" &&
    String(tree[0].title || tree[0].name || "")
      .trim()
      .toLowerCase() === "home" &&
    Array.isArray(tree[0].children)
  ) {
    return tree[0].children;
  }
  if (
    tree.length === 0 &&
    Array.isArray(batch.videos) &&
    batch.videos.length > 0
  ) {
    return batch.videos;
  }
  return tree;
}

export function setEffectiveRootNodes(
  batch: RawBatchFile,
  newRoots: RawBatchNode[]
): RawBatchFile {
  const tree = Array.isArray(batch.tree) ? batch.tree : [];
  if (
    tree.length === 1 &&
    String(tree[0].type || "").toUpperCase() === "FOLDER" &&
    String(tree[0].title || tree[0].name || "")
      .trim()
      .toLowerCase() === "home"
  ) {
    return {
      ...batch,
      tree: [{ ...tree[0], children: newRoots }],
    };
  }
  return {
    ...batch,
    tree: newRoots,
  };
}

/**
 * FAST single-batch loader: only loads the requested batch (prevents phone lag & memory bloat!)
 */
export async function loadSingleRawBatch(
  batchId: string,
  options?: { includeHidden?: boolean }
): Promise<RawBatchFile | null> {
  const cleanId = String(batchId).trim();
  const deletedIds = await getDeletedBatchIds();
  if (deletedIds.has(cleanId)) return null;

  // 1. Check custom DB batch first (overrides static JSON if edited)
  const custom = await getSingleCustomBatch(cleanId);
  if (custom && typeof custom === "object") {
    const parsed = custom as RawBatchFile;
    if (!options?.includeHidden && parsed.hidden) return null;
    return {
      ...parsed,
      id: cleanId,
      name: parsed.name || parsed.title || `Batch ${cleanId}`,
    };
  }

  // 2. Otherwise find matching static JSON in data/batches
  const dir = path.join(process.cwd(), "data", "batches");
  if (fs.existsSync(dir)) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".json"));

    for (const file of files) {
      try {
        const fullPath = path.join(dir, file);
        const raw = fs.readFileSync(fullPath, "utf8");
        const parsed = JSON.parse(raw) as RawBatchFile;
        const fallbackName = file.replace(/\.json$/i, "");
        const idMatch = fallbackName.match(/_(\d+)$/);
        const fid = String(
          parsed.id ?? (idMatch ? idMatch[1] : fallbackName)
        ).trim();

        if (fid === cleanId) {
          if (!options?.includeHidden && parsed.hidden) return null;
          return {
            ...parsed,
            id: cleanId,
            name: parsed.name || parsed.title || fallbackName,
          };
        }
      } catch {
        // skip
      }
    }
  }

  return null;
}

export async function loadAllRawBatches(options?: {
  includeHidden?: boolean;
}): Promise<Map<string, RawBatchFile>> {
  const includeHidden = Boolean(options?.includeHidden);
  const batchesMap = new Map<string, RawBatchFile>();
  const [deletedIds, batchMeta] = await Promise.all([
    getDeletedBatchIds(),
    getAllBatchOrderMeta(),
  ]);

  const dir = path.join(process.cwd(), "data", "batches");

  if (fs.existsSync(dir)) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".json"))
      .sort();

    for (const file of files) {
      try {
        const fullPath = path.join(dir, file);
        const raw = fs.readFileSync(fullPath, "utf8");
        const parsed = JSON.parse(raw) as RawBatchFile;

        const fallbackName = file.replace(/\.json$/i, "");
        const idMatch = fallbackName.match(/_(\d+)$/);
        const id = String(
          parsed.id ?? (idMatch ? idMatch[1] : fallbackName)
        ).trim();

        if (deletedIds.has(id)) continue;

        batchesMap.set(id, {
          ...parsed,
          id,
          name: parsed.name || parsed.title || fallbackName,
        });
      } catch {
        // skip malformed file
      }
    }
  }

  const custom = await getCustomUploadedBatches();
  for (const [key, val] of Object.entries(custom)) {
    if (val && typeof val === "object") {
      const parsed = val as RawBatchFile;
      const id = String(parsed.id || key).trim();
      if (deletedIds.has(id)) continue;
      batchesMap.set(id, {
        ...parsed,
        id,
        name: parsed.name || parsed.title || `Batch ${id}`,
      });
    }
  }

  // Apply global BatchOrderMeta (important star + sortOrder) & sort map entries!
  const entries = Array.from(batchesMap.entries()).filter(
    ([, b]) => includeHidden || !b.hidden
  );

  entries.forEach(([id, b], idx) => {
    const safeKey = id.replace(/[.#$[\]/]/g, "_");
    const meta: BatchOrderMeta | undefined = batchMeta[id] || batchMeta[safeKey];
    if (meta) {
      if (meta.important !== undefined) b.important = Boolean(meta.important);
      if (typeof meta.sortOrder === "number") b.sort_order = meta.sortOrder;
    }
    if (typeof b.sort_order !== "number") {
      b.sort_order = 1000 + idx;
    }
  });

  entries.sort(([, a], [, b]) => {
    const impA = a.important ? 1 : 0;
    const impB = b.important ? 1 : 0;
    if (impA !== impB) return impB - impA;
    return (a.sort_order ?? 9999) - (b.sort_order ?? 9999);
  });

  const sortedMap = new Map<string, RawBatchFile>();
  for (const [id, b] of entries) {
    sortedMap.set(id, b);
  }

  return sortedMap;
}

export function formatBatchSummary(
  batch: RawBatchFile,
  embedKeys?: Set<string>
): BatchSummary {
  const id = String(batch.id || "");
  const name = String(batch.name || batch.title || `Batch ${id}`);
  const thumbnail = String(batch.thumbnail || "").trim();
  const rawPrice = String(batch.price ?? "").trim();
  const numericPrice = Number(rawPrice);

  const hasPositivePrice = !Number.isNaN(numericPrice) && numericPrice > 0;
  const displayPrice = hasPositivePrice ? `₹${numericPrice}` : "FREE";

  const roots = getEffectiveRootNodes(batch);
  const counts = countSubtreeWithLinks(roots, embedKeys, id);

  return {
    id,
    name,
    thumbnail,
    rawPrice,
    displayPrice,
    isFreeTag: true,
    hidden: Boolean(batch.hidden),
    important: Boolean(batch.important),
    sortOrder: typeof batch.sort_order === "number" ? batch.sort_order : 9999,
    source: String(batch.source || "json"),
    totalFolders: counts.folders,
    totalVideos: counts.videos,
    linkedVideos: counts.linkedVideos,
    totalPdfs: counts.pdfs,
    itemCount: batch.item_count || counts.videos + counts.pdfs + counts.folders,
  };
}

export function toCleanNodeItem(
  node: RawBatchNode,
  embedsMap?: Record<string, { rawUrl: string; embedUrl: string }>,
  batchId?: string
): CleanNodeItem {
  const rawType = String(node.type || "FOLDER").toUpperCase();
  const normalizedType: "FOLDER" | "VIDEO" | "PDF" | "LINK" =
    rawType === "VIDEO" || rawType === "PDF" || rawType === "LINK"
      ? rawType
      : "FOLDER";

  const embedKeys = embedsMap ? new Set(Object.keys(embedsMap)) : undefined;

  const subCounts =
    normalizedType === "FOLDER"
      ? countSubtreeWithLinks(node.children || [], embedKeys, batchId)
      : { folders: 0, videos: 0, linkedVideos: 0, pdfs: 0 };

  const directSubfolders =
    normalizedType === "FOLDER" && Array.isArray(node.children)
      ? node.children.filter(
          (c) => String(c.type || "").toUpperCase() === "FOLDER"
        ).length
      : 0;

  const videosCount =
    subCounts.videos > 0
      ? subCounts.videos
      : typeof node.videos_count === "number"
      ? node.videos_count
      : 0;

  const filesCount =
    subCounts.pdfs > 0
      ? subCounts.pdfs
      : typeof node.files_count === "number"
      ? node.files_count
      : 0;

  const nodeId = String(node.id);
  const savedEmbed =
    embedsMap?.[`${batchId}_${nodeId}`] || embedsMap?.[nodeId] || null;

  const rawUrl = savedEmbed?.rawUrl || node.youtube_url || "";
  const embedUrl = savedEmbed?.embedUrl || "";
  const hasYoutubeEmbed = Boolean(rawUrl || embedUrl);
  const hasTelegramStream = Boolean(node.tg_video_token);
  const hasRealPdf = Boolean(
    node.tg_pdf_token ||
      (node.pdf_url && node.pdf_url.startsWith("http")) ||
      (node.link && normalizedType === "PDF" && node.link.startsWith("http"))
  );

  return {
    id: nodeId,
    parentId: String(node.parent_id ?? "-1"),
    title: String(node.title || node.name || "Untitled"),
    type: normalizedType,
    thumbnail: String(node.thumbnail || "").trim(),
    uploadedAt: String(node.uploaded_at || node.date || "").trim(),
    videosCount,
    linkedVideosCount: subCounts.linkedVideos,
    subfoldersCount: directSubfolders,
    filesCount,
    hasAttachedPdf:
      hasRealPdf || Boolean(node.pdf_link_enc) || normalizedType === "PDF",
    hasRealPdf,
    link: node.link,
    hasSubfolders: directSubfolders > 0,
    hasYoutubeEmbed,
    hasTelegramStream,
    rawUrl,
    embedUrl,
    important: Boolean(node.important),
    sortOrder: typeof node.sort_order === "number" ? node.sort_order : 9999,
    fileSize: node.file_size,
  };
}

export function findFolderWithBreadcrumbs(
  nodes: RawBatchNode[],
  targetId: string,
  ancestors: BreadcrumbItem[] = []
): { folder: RawBatchNode; breadcrumbs: BreadcrumbItem[] } | null {
  for (const node of nodes) {
    const id = String(node.id);
    const title = String(node.title || node.name || "Folder");
    if (
      id === String(targetId) &&
      String(node.type || "").toUpperCase() === "FOLDER"
    ) {
      return {
        folder: node,
        breadcrumbs: [...ancestors, { id, title }],
      };
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      const found = findFolderWithBreadcrumbs(node.children, targetId, [
        ...ancestors,
        { id, title },
      ]);
      if (found) return found;
    }
  }
  return null;
}

export function findVideoInBatch(
  nodes: RawBatchNode[],
  targetVideoId: string,
  parentFolder: RawBatchNode | null = null,
  folderPath: string[] = []
): {
  video: RawBatchNode;
  siblings: RawBatchNode[];
  folderTitle: string;
  folderId: string | null;
  folderPath: string[];
} | null {
  for (const node of nodes) {
    const type = String(node.type || "").toUpperCase();
    if (type === "VIDEO" && String(node.id) === String(targetVideoId)) {
      const siblings = sortNodesByImportanceAndOrder(
        nodes.filter((n) => String(n.type || "").toUpperCase() === "VIDEO")
      );
      return {
        video: node,
        siblings,
        folderTitle: parentFolder
          ? String(parentFolder.title || parentFolder.name || "Lectures")
          : "Batch Lectures",
        folderId: parentFolder ? String(parentFolder.id) : null,
        folderPath,
      };
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      const nextPath =
        type === "FOLDER"
          ? [...folderPath, String(node.title || node.name || "Folder")]
          : folderPath;
      const found = findVideoInBatch(
        node.children,
        targetVideoId,
        type === "FOLDER" ? node : parentFolder,
        nextPath
      );
      if (found) return found;
    }
  }
  return null;
}

export function findPdfNodeInBatch(
  nodes: RawBatchNode[],
  targetId: string,
  parentFolder: RawBatchNode | null = null
): {
  node: RawBatchNode;
  folderTitle: string;
  folderId: string | null;
} | null {
  for (const node of nodes) {
    const type = String(node.type || "").toUpperCase();
    if (
      (type === "PDF" || type === "VIDEO") &&
      String(node.id) === String(targetId)
    ) {
      return {
        node,
        folderTitle: parentFolder
          ? String(parentFolder.title || parentFolder.name || "Class Notes")
          : "Batch Notes",
        folderId: parentFolder ? String(parentFolder.id) : null,
      };
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      const found = findPdfNodeInBatch(
        node.children,
        targetId,
        type === "FOLDER" ? node : parentFolder
      );
      if (found) return found;
    }
  }
  return null;
}

export function flattenBatchVideos(
  nodes: RawBatchNode[],
  folderIds: string[] = [],
  folderTitles: string[] = []
): Array<{
  id: string;
  title: string;
  thumbnail: string;
  folderPath: string;
  parentFolderId: string | null;
  uploadedAt: string;
}> {
  const out: Array<{
    id: string;
    title: string;
    thumbnail: string;
    folderPath: string;
    parentFolderId: string | null;
    uploadedAt: string;
  }> = [];

  for (const node of nodes) {
    const type = String(node.type || "").toUpperCase();
    if (type === "VIDEO") {
      out.push({
        id: String(node.id),
        title: String(node.title || node.name || "Untitled Lecture"),
        thumbnail: String(node.thumbnail || "").trim(),
        folderPath: folderTitles.join(" › ") || "Root",
        parentFolderId:
          folderIds.length > 0 ? folderIds[folderIds.length - 1] : null,
        uploadedAt: String(node.uploaded_at || node.date || ""),
      });
    } else if (Array.isArray(node.children) && node.children.length > 0) {
      const sub = flattenBatchVideos(
        node.children,
        [...folderIds, String(node.id)],
        [...folderTitles, String(node.title || node.name || "Folder")]
      );
      out.push(...sub);
    }
  }

  return out;
}

// ============================================================================
// TREE MUTATION HELPERS (Includes TOP, BOTTOM, UP, DOWN, POSITION, IMPORTANT ⭐)
// ============================================================================
export function addNodeToTree(
  roots: RawBatchNode[],
  parentFolderId: string | null,
  newNode: RawBatchNode
): RawBatchNode[] {
  if (!parentFolderId) {
    return [...roots, newNode];
  }
  return roots.map((node) => {
    if (
      String(node.id) === String(parentFolderId) &&
      String(node.type || "").toUpperCase() === "FOLDER"
    ) {
      return {
        ...node,
        children: [...(node.children || []), newNode],
      };
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      return {
        ...node,
        children: addNodeToTree(node.children, parentFolderId, newNode),
      };
    }
    return node;
  });
}

export function updateNodeInTree(
  roots: RawBatchNode[],
  nodeId: string,
  updates: Partial<RawBatchNode>
): RawBatchNode[] {
  return roots.map((node) => {
    if (String(node.id) === String(nodeId)) {
      return { ...node, ...updates };
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      return {
        ...node,
        children: updateNodeInTree(node.children, nodeId, updates),
      };
    }
    return node;
  });
}

export function deleteNodeFromTree(
  roots: RawBatchNode[],
  nodeId: string
): RawBatchNode[] {
  return roots
    .filter((node) => String(node.id) !== String(nodeId))
    .map((node) => {
      if (Array.isArray(node.children) && node.children.length > 0) {
        return {
          ...node,
          children: deleteNodeFromTree(node.children, nodeId),
        };
      }
      return node;
    });
}

export function moveNodeInTree(
  roots: RawBatchNode[],
  nodeId: string,
  direction: "UP" | "DOWN" | "TOP" | "BOTTOM",
  exactPosition?: number
): RawBatchNode[] {
  const hasHere = roots.some((n) => String(n.id) === String(nodeId));
  if (hasHere) {
    // Work on the current visual display order so UP/DOWN/TOP/BOTTOM/POSITION #1..N always behaves 100% predictably!
    const ordered = sortNodesByImportanceAndOrder(roots);
    const idx = ordered.findIndex((n) => String(n.id) === String(nodeId));
    if (idx === -1) return roots;

    let targetIdx = idx;
    if (typeof exactPosition === "number" && !Number.isNaN(exactPosition)) {
      targetIdx = Math.max(0, Math.min(ordered.length - 1, exactPosition - 1));
    } else if (direction === "UP") {
      targetIdx = Math.max(0, idx - 1);
    } else if (direction === "DOWN") {
      targetIdx = Math.min(ordered.length - 1, idx + 1);
    } else if (direction === "TOP") {
      targetIdx = 0;
    } else if (direction === "BOTTOM") {
      targetIdx = ordered.length - 1;
    }

    if (targetIdx === idx) return ordered;

    const copy = [...ordered];
    const [moved] = copy.splice(idx, 1);
    copy.splice(targetIdx, 0, moved);

    // Stamp explicit sort_order 1..N so custom order persists forever
    return copy.map((item, i) => ({
      ...item,
      sort_order: i + 1,
    }));
  }

  return roots.map((node) => {
    if (Array.isArray(node.children) && node.children.length > 0) {
      return {
        ...node,
        children: moveNodeInTree(
          node.children,
          nodeId,
          direction,
          exactPosition
        ),
      };
    }
    return node;
  });
}
