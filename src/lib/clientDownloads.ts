"use client";

// ============================================================================
// 📥 IN-APP OFFLINE MEDIA VAULT  (v3 — "Video website ke andar hi rahe!")
// ============================================================================
// Pehle: Download dabate hi file phone ke browser "Downloads" folder me chali
//        jati thi -> koi bhi us file ko copy/share kar sakta tha.
//
// Ab   : Lecture/PDF **IndexedDB Vault** me 4-4 MB ke tukdo (chunks) me save
//        hota hai. Koi browser-download dialog nahi, koi file phone me nahi.
//        Jab student play karta hai to player **vault se hi** stream karta hai
//        (0% internet, 0% server load, bilkul asli video jaisa smooth).
//
// Low-RAM phone safe:
//   • Download ke dauran ek bhi chunk RAM me ruka nahi rehta — chunk aate hi
//     IndexedDB (disk) me likh diya jata hai aur memory free kar di jati hai.
//   • Play ke waqt sirf Blob *handles* judte hain (data copy nahi hota), Chrome
//     blob ko disk-backed rakhta hai, isliye 400 MB video bhi bina atke chalta
//     hai.
//   • Download **resumable** hai — net gaya to wahi se continue hota hai.
// ============================================================================

export interface SavedDownloadItem {
  id: string;
  batchId: string;
  batchName: string;
  itemId: string;
  title: string;
  kind: "VIDEO" | "PDF";
  thumbnail?: string;
  streamUrl: string;
  totalBytes: number;
  downloadedBytes: number;
  progressPct: number;
  status: "downloading" | "paused" | "completed" | "error";
  hasOfflineBlob: boolean;
  chunkCount?: number;
  errorMsg?: string;
  savedAt: string;
  /** "in-app" = sirf website ke andar (default) | "device" = phone file bhi */
  storageMode?: "in-app" | "device";
}

const STORAGE_META_KEY = "shd_saved_downloads_v3";
const LEGACY_META_KEY = "shd_saved_downloads_v2";
const IDB_NAME = "shd_offline_media_db_v2";
const IDB_CHUNK_STORE = "chunks";
const IDB_BLOB_STORE = "blobs";
const IDB_VERSION = 2;

/** Vault chunk size — 4 MB (400 MB video = ~100 records, RAM flat rehta hai) */
export const VAULT_CHUNK_BYTES = 4 * 1024 * 1024;

/** Network read chunk (HTTP 206 requests) — 2 MB smooth progress ke liye */
const FETCH_CHUNK_BYTES = 2 * 1024 * 1024;

function openMediaIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_CHUNK_STORE)) {
        db.createObjectStore(IDB_CHUNK_STORE);
      }
      if (!db.objectStoreNames.contains(IDB_BLOB_STORE)) {
        db.createObjectStore(IDB_BLOB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

async function idbPut(store: string, key: string, value: Blob): Promise<void> {
  const db = await openMediaIdb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IDB abort"));
  });
  db.close();
}

async function idbGet(store: string, key: string): Promise<Blob | null> {
  const db = await openMediaIdb();
  const out = await new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve((req.result as Blob) || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return out;
}

async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openMediaIdb();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

async function idbGetAllKeys(store: string): Promise<string[]> {
  try {
    const db = await openMediaIdb();
    const keys = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAllKeys();
      req.onsuccess = () => resolve((req.result as string[]) || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return keys.map(String);
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------
// METADATA (localStorage)
// ----------------------------------------------------------------------------
export function loadSavedDownloadsMeta(): SavedDownloadItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw =
      localStorage.getItem(STORAGE_META_KEY) ||
      localStorage.getItem(LEGACY_META_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Purane v2 entries me `paused`/`chunkCount` nahi tha -> normalize
    return parsed.map((x) => ({
      ...x,
      storageMode: x.storageMode || "in-app",
      status: x.status === "downloading" ? "paused" : x.status,
    })) as SavedDownloadItem[];
  } catch {
    return [];
  }
}

export function persistSavedDownloadsMeta(items: SavedDownloadItem[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_META_KEY, JSON.stringify(items));
  } catch {
    // storage full -> ignore
  }
}

// ----------------------------------------------------------------------------
// STORAGE QUOTA (persistent storage maango taaki Chrome vault khali na kare)
// ----------------------------------------------------------------------------
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    // ignore
  }
  return false;
}

export async function getVaultUsage(): Promise<{
  usage: number;
  quota: number;
  persistent: boolean;
}> {
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      return {
        usage: est.usage || 0,
        quota: est.quota || 0,
        persistent: Boolean(navigator.storage?.persisted
          ? await navigator.storage.persisted()
          : false),
      };
    }
  } catch {
    // ignore
  }
  return { usage: 0, quota: 0, persistent: false };
}

// ----------------------------------------------------------------------------
// VAULT READ / WRITE
// ----------------------------------------------------------------------------
const objectUrlCache = new Map<string, string>();

/** Kitne chunks pehle se vault me maujood hain (resume ke liye) */
export async function getVaultChunkCount(id: string): Promise<number> {
  const keys = await idbGetAllKeys(IDB_CHUNK_STORE);
  const prefix = `${id}#`;
  return keys.filter((k) => k.startsWith(prefix)).length;
}

/**
 * Vault se poora media Blob banata hai — bina data copy kiye (sirf handles),
 * isliye 400 MB video bhi low-RAM phone par turant khulta hai.
 */
export async function getOfflineBlobFromIdb(
  id: string,
  mimeType = "video/mp4"
): Promise<Blob | null> {
  // 1. Legacy single-blob entry (v1/v2 se)
  const legacy = await idbGet(IDB_BLOB_STORE, id);
  if (legacy) return legacy;

  // 2. Chunked vault entry
  const keys = await idbGetAllKeys(IDB_CHUNK_STORE);
  const prefix = `${id}#`;
  const chunkKeys = keys
    .filter((k) => k.startsWith(prefix))
    .sort((a, b) => {
      const na = parseInt(a.slice(prefix.length), 10) || 0;
      const nb = parseInt(b.slice(prefix.length), 10) || 0;
      return na - nb;
    });

  if (chunkKeys.length === 0) return null;

  const parts: Blob[] = [];
  let total = 0;
  for (const k of chunkKeys) {
    const b = await idbGet(IDB_CHUNK_STORE, k);
    if (!b) return null; // adhoora vault -> treat as not downloaded
    parts.push(b);
    total += b.size;
  }
  if (total === 0) return null;
  return new Blob(parts, { type: mimeType });
}

/** Play-ready Object URL (cache rakhta hai taaki dubara-dubara na bane) */
export async function getOfflineObjectUrl(
  id: string,
  mimeType = "video/mp4"
): Promise<string | null> {
  const cached = objectUrlCache.get(id);
  if (cached) return cached;
  const blob = await getOfflineBlobFromIdb(id, mimeType);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  objectUrlCache.set(id, url);
  return url;
}

export function releaseOfflineObjectUrl(id: string): void {
  const url = objectUrlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrlCache.delete(id);
  }
}

export async function deleteOfflineBlobFromIdb(id: string): Promise<void> {
  releaseOfflineObjectUrl(id);
  try {
    await idbDelete(IDB_BLOB_STORE, id);
  } catch {
    // ignore
  }
  const keys = await idbGetAllKeys(IDB_CHUNK_STORE);
  const prefix = `${id}#`;
  for (const k of keys) {
    if (k.startsWith(prefix)) {
      try {
        await idbDelete(IDB_CHUNK_STORE, k);
      } catch {
        // ignore
      }
    }
  }
}

export async function saveOfflineBlobToIdb(
  id: string,
  blob: Blob
): Promise<boolean> {
  try {
    await idbPut(IDB_BLOB_STORE, id, blob);
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// RESUMABLE CHUNKED DOWNLOADER -> VAULT
// ----------------------------------------------------------------------------
export interface VaultDownloadOptions {
  id: string;
  url: string;
  mimeType: string;
  knownSize?: number;
  startFromBytes?: number;
  signal?: AbortSignal;
  onProgress?: (downloaded: number, total: number, pct: number) => void;
}

/**
 * HTTP 206 byte-range chunks me media download karke seedha IndexedDB vault me
 * likhta hai. RAM me poora file kabhi hold nahi hota. Adhura reh gaya to
 * `startFromBytes` se resume ho jata hai.
 */
export async function downloadStreamToVault(
  opts: VaultDownloadOptions
): Promise<{ totalBytes: number; chunkCount: number }> {
  await requestPersistentStorage();

  let start = Math.max(0, opts.startFromBytes || 0);
  let totalSize = opts.knownSize || 0;

  // Already-written chunks ka hisab (resume)
  let chunkIndex = Math.floor(start / VAULT_CHUNK_BYTES);
  let currentChunkParts: BlobPart[] = [];
  let currentChunkBytes = start - chunkIndex * VAULT_CHUNK_BYTES;

  const flushChunk = async () => {
    if (currentChunkBytes <= 0 || currentChunkParts.length === 0) return;
    const blob = new Blob(currentChunkParts, { type: opts.mimeType });
    await idbPut(IDB_CHUNK_STORE, `${opts.id}#${chunkIndex}`, blob);
    chunkIndex += 1;
    currentChunkParts = [];
    currentChunkBytes = 0;
  };

  let guard = 0;
  while (guard < 20000) {
    guard += 1;
    if (opts.signal?.aborted) throw new Error("Download cancelled");
    if (totalSize > 0 && start >= totalSize) break;

    const end = start + FETCH_CHUNK_BYTES - 1;
    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: "GET",
        headers: {
          Range: `bytes=${start}-${end}`,
          "X-SHD-Client": "web-player",
        },
        signal: opts.signal,
        cache: "no-store",
      });
    } catch {
      // Network drop -> retry (resume-safe)
      await new Promise((r) => setTimeout(r, 1200));
      if (opts.signal?.aborted) throw new Error("Download cancelled");
      continue;
    }

    if (!res.ok && res.status !== 206) {
      if (res.status === 416) break; // range beyond EOF
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw new Error(`Stream error (${res.status})`);
    }

    const contentRange = res.headers.get("Content-Range");
    const customTotal = res.headers.get("X-SHD-Total-Size");
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)/);
      if (m) totalSize = parseInt(m[1], 10);
      // Server ne WAHI start byte bheja hai na? (byte-exact guarantee)
      const sm = contentRange.match(/bytes\s+(\d+)-/i);
      if (sm && parseInt(sm[1], 10) !== start) {
        throw new Error("Stream byte mismatch — please retry");
      }
    } else if (customTotal) {
      const parsed = parseInt(customTotal, 10);
      if (!Number.isNaN(parsed) && parsed > 0) totalSize = parsed;
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) break;

    currentChunkParts.push(new Blob([buf], { type: opts.mimeType }));
    currentChunkBytes += buf.byteLength;
    start += buf.byteLength;

    if (currentChunkBytes >= VAULT_CHUNK_BYTES) {
      await flushChunk();
    }

    const pct =
      totalSize > 0 ? Math.min(99, Math.round((start / totalSize) * 100)) : 50;
    opts.onProgress?.(start, totalSize || start, pct);

    if (res.status === 200 || (totalSize > 0 && start >= totalSize)) break;
  }

  await flushChunk();
  opts.onProgress?.(start, totalSize || start, 100);

  return { totalBytes: start, chunkCount: chunkIndex };
}

/**
 * Simple full-blob downloader (chhote PDFs / legacy path ke liye).
 */
export async function downloadStreamInChunks(params: {
  url: string;
  mimeType: string;
  knownSize?: number;
  onProgress?: (downloaded: number, total: number, pct: number) => void;
  signal?: AbortSignal;
}): Promise<Blob> {
  const parts: BlobPart[] = [];
  let start = 0;
  let totalSize = params.knownSize || 0;

  while (true) {
    if (params.signal?.aborted) throw new Error("Download cancelled");

    const end = start + FETCH_CHUNK_BYTES - 1;
    const res = await fetch(params.url, {
      method: "GET",
      headers: {
        Range: `bytes=${start}-${end}`,
        "X-SHD-Client": "web-player",
      },
      signal: params.signal,
    });

    if (!res.ok && res.status !== 206) throw new Error(`Stream error (${res.status})`);

    const contentRange = res.headers.get("Content-Range");
    const customTotal = res.headers.get("X-SHD-Total-Size");
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)/);
      if (m) totalSize = parseInt(m[1], 10);
    } else if (customTotal) {
      const parsed = parseInt(customTotal, 10);
      if (!Number.isNaN(parsed) && parsed > 0) totalSize = parsed;
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) break;

    parts.push(buf);
    start += buf.byteLength;

    const pct =
      totalSize > 0 ? Math.min(99, Math.round((start / totalSize) * 100)) : 50;
    params.onProgress?.(start, totalSize || start, pct);

    if (res.status === 200 || (totalSize > 0 && start >= totalSize)) break;
  }

  params.onProgress?.(start, totalSize || start, 100);
  return new Blob(parts, { type: params.mimeType });
}

/** OPTIONAL: jab student khud phone me file save karna chahe (explicit click) */
export function triggerBrowserBlobSave(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
}

export function shouldCacheOfflineInIdb(
  _kind: "VIDEO" | "PDF",
  sizeBytes: number
): boolean {
  // v3 vault me koi upper-cap nahi: video/PDF dono in-app save hote hain.
  return sizeBytes > 0;
}

export function formatBytesHuman(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
