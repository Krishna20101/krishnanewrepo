import "server-only";
import crypto from "crypto";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import bigInt from "big-integer";
import {
  getTelegramVaultCredentials,
  TelegramCredentialsSecret,
} from "./db";
import type { ScannedTelegramItem } from "./tgParser";
import { extractYoutubeFromText } from "./tgParser";

export const MTPROTO_CHUNK_BYTES = 512 * 1024; // 512 KB aligned stripe
export const MAX_BOUNDED_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Ek hi HTTP 206 response me maximum kitne bytes bheje jayen.
 * Vercel Hobby par function ka real time-limit ~60s hota hai, isliye 400 MB
 * lecture ko ek hi invocation me pura stream karna risky tha (stream beech me
 * kat jata tha = video atak kar frames repeat/jump karta tha).
 *
 * Ab server sirf 32 MB bhejta hai aur `Content-Range: bytes X-(X+32MB-1)/TOTAL`
 * deta hai. Chrome khud agla 32 MB turant maang leta hai (ye standard
 * progressive-MP4 behaviour hai) — isse:
 *   • har invocation chhoti + fast rehti hai (koi timeout nahi)
 *   • Lambda memory kam lagti hai (low-cost, smooth)
 *   • ek hi Session/Bot connection par load kam = 0% collision
 */
export const MAX_STREAM_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface ResolvedTelegramMediaMeta {
  chatId: string;
  messageId: number;
  dcId: number;
  id: bigInt.BigInteger;
  accessHash: bigInt.BigInteger;
  fileReference: Buffer;
  totalSize: number;
  mimeType: string;
  fileName: string;
  viaBot: boolean;
  resolvedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __shdBotClientEntry:
    | {
        hash: string;
        client?: TelegramClient;
        connecting?: Promise<TelegramClient>;
      }
    | undefined;
  // eslint-disable-next-line no-var
  var __shdUserStreamClientEntry:
    | {
        hash: string;
        client?: TelegramClient;
        connecting?: Promise<TelegramClient>;
        activeOps: number;
        idleTimer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  // eslint-disable-next-line no-var
  var __shdTgCredsCache:
    | {
        creds: TelegramCredentialsSecret;
        expiresAt: number;
      }
    | undefined;
  // eslint-disable-next-line no-var
  var __shdMediaMetaCache: Map<string, ResolvedTelegramMediaMeta> | undefined;
  // eslint-disable-next-line no-var
  var __shdBlockLruCache: Map<string, Buffer> | undefined;
}

const thumbMemoryCache = new Map<string, Buffer>();
const USER_STREAM_IDLE_DISCONNECT_MS = 18_000; // Disconnect idle user session in 18s so Vercel containers never collide!

/**
 * Telegram captions kabhi-kabhi broken bytes / control characters / extractor
 * crash-logs ("Error: 'utf-8' codec can't decode byte 0xe0 ...") le kar aate
 * hain. Ye helper unhe saaf karta hai taaki title/folder me kachra na jaye aur
 * server par kabhi bhi UTF-8 decode crash na ho.
 */
export function sanitizeCaptionText(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  let s = String(raw);

  // Remove lone surrogates + C0/C1 control chars (except \n \r \t)
  s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
  s = s.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ");

  return s.replace(/\r\n/g, "\n").trim();
}

/**
 * Caption-only lecture detection: kuch classes Telegram par .mp4 file ke bina
 * sirf caption me YouTube link ke saath post hoti hain. Unhe course me tabhi
 * joda jata hai jab caption me Title + (Batch/Topic/Course/Subject) mile,
 * warna random links course ko ganda kar denge.
 */
function captionOnlyYoutubeLink(caption: string): string {
  if (!caption) return "";
  const yt = extractYoutubeFromText(caption);
  if (!yt) return "";

  const hasTitle = /^\s*(?:title|name|lecture|video|class|pdf|file)\s*[:\-–—]\s*\S/im.test(
    caption
  );
  const hasCourseMeta =
    /^\s*(?:batch|course|batch\s*name|course\s*name|topic|folder|chapter|subject)\s*[:\-–—]\s*\S/im.test(
      caption
    );

  if (hasTitle && hasCourseMeta) return yt;
  return "";
}

export function formatTelegramError(err: unknown): string {
  const raw = String(
    (err as { errorMessage?: string; message?: string })?.errorMessage ||
      (err as { message?: string })?.message ||
      err ||
      "Telegram error"
  );

  if (raw.includes("AUTH_KEY_DUPLICATED")) {
    return (
      "406 AUTH_KEY_DUPLICATED: Ye purana Session String 2 alag IP par ek saath khulne ki wajah se Telegram ne expire kar diya hai (aapka Telegram account 100% safe hai!). " +
      "Fix: Bas 'python session.py' dubara chala kar NAYA Session String Box 1 me Save karein — aur permanent 0-error streaming ke liye saath me Optional @BotFather Bot Token bhi daal dein!"
    );
  }
  if (raw.includes("AUTH_KEY_UNREGISTERED") || raw.includes("SESSION_REVOKED")) {
    return "Session String expire ya logout ho gaya hai. Kripya 'python session.py' se naya Session String bana kar Box 1 me Save karein.";
  }
  return raw;
}

function getMediaMetaCache(): Map<string, ResolvedTelegramMediaMeta> {
  if (!globalThis.__shdMediaMetaCache) {
    globalThis.__shdMediaMetaCache = new Map();
  }
  return globalThis.__shdMediaMetaCache;
}

function getBlockLruCache(): Map<string, Buffer> {
  if (!globalThis.__shdBlockLruCache) {
    globalThis.__shdBlockLruCache = new Map();
  }
  return globalThis.__shdBlockLruCache;
}

function putBlockLru(key: string, data: Buffer): void {
  const cache = getBlockLruCache();
  if (cache.has(key)) cache.delete(key);
  cache.set(key, data);
  while (cache.size > 16) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
    else break;
  }
}

export function invalidateCachedTelegramCreds(): void {
  globalThis.__shdTgCredsCache = undefined;
  globalThis.__shdMediaMetaCache?.clear();
}

async function safeDestroyClient(client?: TelegramClient): Promise<void> {
  if (!client) return;
  try {
    await client.destroy();
  } catch {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
}

async function getFastTelegramCredentials(
  overrideCreds?: TelegramCredentialsSecret
): Promise<TelegramCredentialsSecret | null> {
  if (overrideCreds) return overrideCreds;
  const now = Date.now();
  if (
    globalThis.__shdTgCredsCache &&
    globalThis.__shdTgCredsCache.expiresAt > now
  ) {
    return globalThis.__shdTgCredsCache.creds;
  }
  const creds = await getTelegramVaultCredentials();
  if (creds) {
    globalThis.__shdTgCredsCache = {
      creds,
      expiresAt: now + 5 * 60 * 1000,
    };
  }
  return creds;
}

export function normalizeChatInput(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^https?:\/\/(?:www\.)?t(?:elegram)?\.me\//i, "");
  s = s.replace(/\/.*$/, "");
  if (s.startsWith("@")) s = s.slice(1);
  return s.trim();
}

function resolveEntityTarget(chatInput: string): string | bigInt.BigInteger {
  const clean = normalizeChatInput(chatInput);
  if (/^-?\d+$/.test(clean)) {
    return bigInt(clean);
  }
  return clean;
}

/**
 * Creates a short-lived Admin client that ALWAYS disconnects in `finally {}`!
 * Prevents `/api/admin/telegram` container from holding `StringSession` open
 * and colliding with `/api/tg/stream` on another Vercel IP!
 */
async function withEphemeralUserClient<T>(
  creds: TelegramCredentialsSecret,
  fn: (client: TelegramClient) => Promise<T>
): Promise<T> {
  // Also close any idle user stream client in this same process first
  if (globalThis.__shdUserStreamClientEntry?.client) {
    const old = globalThis.__shdUserStreamClientEntry.client;
    globalThis.__shdUserStreamClientEntry = undefined;
    await safeDestroyClient(old);
  }

  const session = new StringSession(creds.sessionString.trim());
  const client = new TelegramClient(
    session,
    Number(creds.apiId),
    creds.apiHash.trim(),
    {
      connectionRetries: 2,
      useWSS: false,
      autoReconnect: false,
    }
  );
  client.setLogLevel("none" as never);

  try {
    await client.connect();
    return await fn(client);
  } finally {
    await safeDestroyClient(client);
  }
}

export async function verifyTelegramCredentialsEphemeral(
  creds: TelegramCredentialsSecret
): Promise<{ accountLabel: string; botUsername?: string }> {
  const accountLabel = await withEphemeralUserClient(creds, async (client) => {
    const me = await client.getMe();
    return (me && "firstName" in me && me.firstName) || "Telegram Account";
  });

  let botUsername: string | undefined;
  if (creds.botToken && creds.botToken.trim()) {
    const botClient = new TelegramClient(
      new StringSession(""),
      Number(creds.apiId),
      creds.apiHash.trim(),
      {
        connectionRetries: 2,
        useWSS: false,
        autoReconnect: false,
      }
    );
    botClient.setLogLevel("none" as never);
    try {
      await botClient.start({ botAuthToken: creds.botToken.trim() });
      const botMe = await botClient.getMe();
      if (botMe && "username" in botMe && botMe.username) {
        botUsername = `@${botMe.username}`;
      }
    } finally {
      await safeDestroyClient(botClient);
    }
  }

  return { accountLabel, botUsername };
}

/**
 * BOT STREAM CLIENT (100% Immune to `406: AUTH_KEY_DUPLICATED`!):
 * Every Vercel serverless container creates its own independent `StringSession("")`
 * via `botAuthToken`, so 100 parallel serverless IPs NEVER share an `auth_key`!
 */
async function getBotStreamClient(
  creds: TelegramCredentialsSecret
): Promise<TelegramClient | null> {
  const token = creds.botToken?.trim();
  if (!token) return null;

  const hash = crypto
    .createHash("sha256")
    .update(`bot:${creds.apiId}:${creds.apiHash}:${token}`)
    .digest("hex");

  const existing = globalThis.__shdBotClientEntry;
  if (existing && existing.hash === hash) {
    if (existing.client && existing.client.connected) {
      return existing.client;
    }
    if (existing.connecting) {
      return existing.connecting;
    }
  }

  if (existing?.client) {
    await safeDestroyClient(existing.client);
  }

  const connecting = (async () => {
    const client = new TelegramClient(
      new StringSession(""),
      Number(creds.apiId),
      creds.apiHash.trim(),
      {
        connectionRetries: 3,
        useWSS: false,
        autoReconnect: true,
      }
    );
    client.setLogLevel("none" as never);
    await client.start({ botAuthToken: token });
    return client;
  })();

  globalThis.__shdBotClientEntry = { hash, connecting };
  try {
    const client = await connecting;
    globalThis.__shdBotClientEntry = { hash, client };
    return client;
  } catch (err) {
    globalThis.__shdBotClientEntry = undefined;
    throw err;
  }
}

/**
 * USER STREAM CLIENT FALLBACK (For private user-only groups without a bot):
 * Uses single-flight connection mutex + 18-second idle auto-disconnect so idle
 * Vercel containers immediately release `StringSession`!
 */
async function acquireUserStreamClient(
  creds: TelegramCredentialsSecret
): Promise<{ client: TelegramClient; release: () => void }> {
  const hash = crypto
    .createHash("sha256")
    .update(`user:${creds.apiId}:${creds.apiHash}:${creds.sessionString}`)
    .digest("hex");

  let entry = globalThis.__shdUserStreamClientEntry;
  if (entry && entry.hash !== hash) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    await safeDestroyClient(entry.client);
    entry = undefined;
    globalThis.__shdUserStreamClientEntry = undefined;
  }

  if (!entry) {
    entry = { hash, activeOps: 0 };
    globalThis.__shdUserStreamClientEntry = entry;
  }

  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  entry.activeOps += 1;

  const scheduleRelease = () => {
    if (!entry) return;
    entry.activeOps = Math.max(0, entry.activeOps - 1);
    if (entry.activeOps === 0) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(async () => {
        if (entry && entry.activeOps === 0 && entry.client) {
          const c = entry.client;
          entry.client = undefined;
          entry.connecting = undefined;
          await safeDestroyClient(c);
        }
      }, USER_STREAM_IDLE_DISCONNECT_MS);
    }
  };

  try {
    if (entry.client && entry.client.connected) {
      return { client: entry.client, release: scheduleRelease };
    }

    if (!entry.connecting) {
      entry.connecting = (async () => {
        const session = new StringSession(creds.sessionString.trim());
        const c = new TelegramClient(
          session,
          Number(creds.apiId),
          creds.apiHash.trim(),
          {
            connectionRetries: 2,
            useWSS: false,
            autoReconnect: false,
          }
        );
        c.setLogLevel("none" as never);
        await c.connect();
        return c;
      })();
    }

    const client = await entry.connecting;
    entry.client = client;
    entry.connecting = undefined;
    return { client, release: scheduleRelease };
  } catch (err) {
    entry.connecting = undefined;
    scheduleRelease();
    throw err;
  }
}

function formatMessageDate(dateUnix?: number): string {
  if (!dateUnix) return "";
  try {
    const d = new Date(dateUnix * 1000);
    return d.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export async function scanTelegramGroupMedia(params: {
  chatInput: string;
  limit?: number;
  overrideCreds?: TelegramCredentialsSecret;
}): Promise<{
  canonicalChatId: string;
  groupTitle: string;
  items: ScannedTelegramItem[];
}> {
  if (params.overrideCreds) {
    invalidateCachedTelegramCreds();
  }
  const creds = await getFastTelegramCredentials(params.overrideCreds);
  if (!creds || !creds.apiId || !creds.apiHash || !creds.sessionString) {
    throw new Error(
      "Telegram credentials missing! Please save API ID, API Hash, and Session String in Admin -> Telegram Sync Studio."
    );
  }

  return withEphemeralUserClient(creds, async (client) => {
    const target = resolveEntityTarget(params.chatInput);
    const entity = await client.getEntity(target);

    const groupTitle =
      ("title" in entity && typeof entity.title === "string" && entity.title) ||
      ("username" in entity &&
        typeof entity.username === "string" &&
        entity.username) ||
      normalizeChatInput(params.chatInput);

    let canonicalChatId = normalizeChatInput(params.chatInput);
    if ("username" in entity && entity.username) {
      canonicalChatId = String(entity.username);
    } else if ("id" in entity && entity.id) {
      const rawId = String(entity.id);
      canonicalChatId =
        entity instanceof Api.Channel && !rawId.startsWith("-100")
          ? `-100${rawId}`
          : rawId;
    }

    const maxMessages = Math.min(Math.max(params.limit || 1500, 50), 5000);
    const items: ScannedTelegramItem[] = [];

    for await (const msg of client.iterMessages(entity, {
      limit: maxMessages,
    })) {
      if (!msg) continue;

      const captionText = sanitizeCaptionText(msg.message);

      // ---------------------------------------------------------------
      // CASE A: Message me real .mp4 / .pdf FILE attach hai
      // ---------------------------------------------------------------
      if (
        msg.media &&
        msg.media instanceof Api.MessageMediaDocument &&
        msg.media.document
      ) {
        const doc = msg.media.document;
        if (!(doc instanceof Api.Document)) continue;

        const mime = String(doc.mimeType || "").toLowerCase();
        let fileName = "";
        let durationSec: number | undefined;
        let isVideoAttr = false;

        for (const attr of doc.attributes || []) {
          if (attr instanceof Api.DocumentAttributeFilename) {
            fileName = attr.fileName || "";
          } else if (attr instanceof Api.DocumentAttributeVideo) {
            isVideoAttr = true;
            durationSec = attr.duration;
          }
        }

        const lowerName = fileName.toLowerCase();
        const isVideo =
          isVideoAttr ||
          mime.startsWith("video/") ||
          /\.(mp4|mkv|webm|mov|m4v|avi)$/i.test(lowerName);
        const isPdf = mime === "application/pdf" || lowerName.endsWith(".pdf");

        if (!isVideo && !isPdf) continue;

        const fileSize = Number(doc.size?.toString() || "0");
        const hasThumb = Boolean(doc.thumbs && doc.thumbs.length > 0);

        items.push({
          chatId: canonicalChatId,
          messageId: msg.id,
          kind: isVideo ? "VIDEO" : "PDF",
          caption: captionText,
          fileName:
            fileName ||
            `${isVideo ? "lecture" : "notes"}_${msg.id}.${
              isVideo ? "mp4" : "pdf"
            }`,
          fileSize,
          mimeType: mime || (isVideo ? "video/mp4" : "application/pdf"),
          durationSec,
          hasThumb,
          uploadedAt: formatMessageDate(msg.date),
          hasMediaFile: true,
          captionYoutubeUrl: extractYoutubeFromText(captionText) || undefined,
        });
        continue;
      }

      // ---------------------------------------------------------------
      // CASE B: Caption-only lecture — file nahi, sirf YouTube link hai
      // (jaise: "Index: 724 / Title: 6. तुमुल कोलाहल... / Batch: 12th
      //  Science... / Link: https://youtu.be/UxWH-mIFA6E / Error: 'utf-8'...")
      // ---------------------------------------------------------------
      const captionYt = captionOnlyYoutubeLink(captionText);
      if (!captionYt) continue;

      items.push({
        chatId: canonicalChatId,
        messageId: msg.id,
        kind: "VIDEO",
        caption: captionText,
        fileName: "",
        fileSize: 0,
        mimeType: "video/mp4",
        hasThumb: false,
        uploadedAt: formatMessageDate(msg.date),
        hasMediaFile: false,
        captionYoutubeUrl: captionYt,
      });
    }

    items.reverse();

    return {
      canonicalChatId,
      groupTitle,
      items,
    };
  });
}

async function extractMediaMetaFromClient(
  client: TelegramClient,
  params: {
    chatId: string;
    messageId: number;
    knownTotalSize?: number;
    knownMimeType?: string;
    knownFileName?: string;
  },
  viaBot: boolean
): Promise<ResolvedTelegramMediaMeta> {
  const target = resolveEntityTarget(params.chatId);
  const messages = await client.getMessages(target, {
    ids: [params.messageId],
  });
  const msg = messages?.[0];

  if (
    !msg ||
    !msg.media ||
    !(msg.media instanceof Api.MessageMediaDocument) ||
    !(msg.media.document instanceof Api.Document)
  ) {
    throw new Error("Media message not found in Telegram group.");
  }

  const doc = msg.media.document;
  const totalSize =
    Number(doc.size?.toString() || "0") || params.knownTotalSize || 0;
  if (totalSize <= 0) {
    throw new Error("Empty media document.");
  }

  let fileName = params.knownFileName || `media_${params.messageId}`;
  for (const attr of doc.attributes || []) {
    if (attr instanceof Api.DocumentAttributeFilename && attr.fileName) {
      fileName = attr.fileName;
    }
  }

  const mimeType =
    doc.mimeType || params.knownMimeType || "application/octet-stream";

  return {
    chatId: params.chatId,
    messageId: params.messageId,
    dcId: doc.dcId,
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: Buffer.from(doc.fileReference),
    totalSize,
    mimeType,
    fileName,
    viaBot,
    resolvedAt: Date.now(),
  };
}

/**
 * Resolves & caches Telegram Document location metadata.
 * Automatically prefers Bot MTProto (100% immune to AUTH_KEY_DUPLICATED across IPs!)
 * and falls back cleanly to User Session if the group is private user-only.
 */
export async function resolveTelegramMediaMeta(params: {
  chatId: string;
  messageId: number;
  knownTotalSize?: number;
  knownMimeType?: string;
  knownFileName?: string;
  forceRefresh?: boolean;
}): Promise<ResolvedTelegramMediaMeta> {
  const cacheKey = `${normalizeChatInput(params.chatId)}:${params.messageId}`;
  const metaCache = getMediaMetaCache();
  const now = Date.now();

  if (!params.forceRefresh) {
    const cached = metaCache.get(cacheKey);
    if (cached && now - cached.resolvedAt < 40 * 60 * 1000) {
      return cached;
    }
  }

  const creds = await getFastTelegramCredentials();
  if (!creds || !creds.apiId || !creds.apiHash) {
    throw new Error(
      "Telegram credentials missing! Please configure Admin -> Telegram Sync Studio."
    );
  }

  let resolved: ResolvedTelegramMediaMeta | null = null;

  // 1. Try Bot MTProto Client FIRST if botToken is configured (Zero AUTH_KEY_DUPLICATED!)
  if (creds.botToken?.trim()) {
    try {
      const botClient = await getBotStreamClient(creds);
      if (botClient) {
        resolved = await extractMediaMetaFromClient(botClient, params, true);
      }
    } catch {
      // Bot might not be in a private user-only group -> fall back to user session
      resolved = null;
    }
  }

  // 2. Fallback to Idle-Managed User Stream Client
  if (!resolved) {
    if (!creds.sessionString) {
      throw new Error("Telegram Session String missing in Vault.");
    }
    const { client, release } = await acquireUserStreamClient(creds);
    try {
      resolved = await extractMediaMetaFromClient(client, params, false);
    } finally {
      release();
    }
  }

  if (metaCache.size > 500) {
    const firstKey = metaCache.keys().next().value;
    if (firstKey !== undefined) metaCache.delete(firstKey);
  }
  metaCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * ============================================================================
 * BYTE-EXACT 512 KB BLOCK READER (Anti "Jhal-Jhal" / Anti Frame-Jump Engine!)
 * ============================================================================
 * Telegram ka `upload.getFile` kabhi-kabhi ek short read deta hai (network
 * hiccup / DC migration / flood-wait). Purana code us short block ko chup-chaap
 * accept kar leta tha, jisse MP4 ke beech ke bytes MISS ho jate the aur Chrome
 * ka decoder frames ko aage-piche phenkta tha = "video ke andar ka character
 * pure time hilta / jhal-jhal karta dikhta tha" (audio sahi chalta tha kyunki
 * AAC frames independent hote hain).
 *
 * Ab: har block ko tab tak padha jata hai jab tak wo EXACTLY pura na ho jaye
 * (fill-loop + retry). Agar block pura nahi ho sakta to error throw hota hai,
 * jisse browser us range ko dubara maangta hai — corrupt bytes KABHI nahi
 * bheje jate. Ye hi Cloudflare Worker + Vercel dono par smooth playback ki
 * asli jad (root) fix hai.
 * ============================================================================
 */
export async function fetchAligned512KBBlock(
  meta: ResolvedTelegramMediaMeta,
  alignedOffset: number
): Promise<{ bytes: Buffer; updatedMeta: ResolvedTelegramMediaMeta }> {
  if (alignedOffset >= meta.totalSize) {
    return { bytes: Buffer.alloc(0), updatedMeta: meta };
  }

  const expectedBytes = Math.min(
    MTPROTO_CHUNK_BYTES,
    meta.totalSize - alignedOffset
  );

  const blockKey = `${normalizeChatInput(meta.chatId)}:${meta.messageId}:${alignedOffset}`;
  const cachedBlock = getBlockLruCache().get(blockKey);
  if (cachedBlock && cachedBlock.length === expectedBytes) {
    return { bytes: cachedBlock, updatedMeta: meta };
  }
  if (cachedBlock && cachedBlock.length !== expectedBytes) {
    // Corrupt/short cache entry -> discard so it is re-fetched byte-exactly
    getBlockLruCache().delete(blockKey);
  }

  const creds = await getFastTelegramCredentials();
  if (!creds) {
    throw new Error("Telegram credentials missing.");
  }

  let currentMeta = meta;
  let targetDc = currentMeta.dcId;
  const collected: Buffer[] = [];
  let collectedBytes = 0;

  /** One single `upload.getFile` call with full DC-migration / file-reference recovery */
  const readOnce = async (offset: number, limit: number): Promise<Buffer> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      let releaseFn: (() => void) | null = null;
      try {
        let client: TelegramClient;
        if (currentMeta.viaBot && creds.botToken?.trim()) {
          const bc = await getBotStreamClient(creds);
          if (!bc) throw new Error("Bot client unavailable");
          client = bc;
        } else {
          const acquired = await acquireUserStreamClient(creds);
          client = acquired.client;
          releaseFn = acquired.release;
        }

        const sender = await client.getSender(targetDc);
        const req = new Api.upload.GetFile({
          precise: true,
          cdnSupported: false,
          location: new Api.InputDocumentFileLocation({
            id: currentMeta.id,
            accessHash: currentMeta.accessHash,
            fileReference: currentMeta.fileReference,
            thumbSize: "",
          }),
          offset: bigInt(offset),
          limit,
        });

        const res = await client.invokeWithSender(req, sender);
        if (res instanceof Api.upload.File && res.bytes) {
          return Buffer.isBuffer(res.bytes)
            ? res.bytes
            : Buffer.from(res.bytes as Uint8Array);
        }
        return Buffer.alloc(0);
      } catch (err: unknown) {
        const errMsg = String(
          (err as { errorMessage?: string; message?: string })?.errorMessage ||
            (err as { message?: string })?.message ||
            ""
        );
        const newDc = (err as { newDc?: number })?.newDc;

        if (newDc) {
          targetDc = newDc;
          currentMeta = { ...currentMeta, dcId: newDc };
          continue;
        }

        if (errMsg.includes("FILE_MIGRATE_")) {
          const m = errMsg.match(/FILE_MIGRATE_(\d+)/);
          if (m) {
            targetDc = Number(m[1]);
            currentMeta = { ...currentMeta, dcId: targetDc };
            continue;
          }
        }

        if (
          errMsg.includes("FILE_REFERENCE") ||
          errMsg.includes("FILEREF_UPGRADE_NEEDED")
        ) {
          currentMeta = await resolveTelegramMediaMeta({
            chatId: currentMeta.chatId,
            messageId: currentMeta.messageId,
            knownTotalSize: currentMeta.totalSize,
            knownMimeType: currentMeta.mimeType,
            knownFileName: currentMeta.fileName,
            forceRefresh: true,
          });
          targetDc = currentMeta.dcId;
          continue;
        }

        if (attempt < 3) {
          // TIMEOUT / FLOOD_WAIT / connection reset -> retry same offset
          const flood = errMsg.match(/FLOOD_WAIT_(\d+)/);
          const waitMs = flood
            ? Math.min(4000, Number(flood[1]) * 1000)
            : 350 * (attempt + 1);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        throw new Error(formatTelegramError(err));
      } finally {
        if (releaseFn) releaseFn();
      }
    }
    throw new Error("Unable to read media block from Telegram DC.");
  };

  // FILL LOOP: keep reading until the 512 KB stripe is byte-exact complete
  let cursor = alignedOffset;
  for (let pass = 0; pass < 6 && collectedBytes < expectedBytes; pass++) {
    const want = expectedBytes - collectedBytes;
    // Telegram requires offset & limit to be multiples of 1024 bytes
    const limit = Math.max(1024, Math.floor(want / 1024) * 1024);
    const buf = await readOnce(cursor, Math.min(limit, MTPROTO_CHUNK_BYTES));

    if (!buf || buf.length === 0) break; // true EOF

    collected.push(buf);
    collectedBytes += buf.length;
    cursor += buf.length;

    if (collectedBytes >= expectedBytes) break;
    if (cursor >= currentMeta.totalSize) break;
    if (buf.length % 1024 !== 0) break; // keep next offset 1024-aligned
  }

  if (collectedBytes === 0) {
    return { bytes: Buffer.alloc(0), updatedMeta: currentMeta };
  }

  let block =
    collected.length === 1 ? collected[0] : Buffer.concat(collected, collectedBytes);

  if (block.length > expectedBytes) {
    block = block.subarray(0, expectedBytes);
  }

  if (block.length < expectedBytes && cursor < currentMeta.totalSize) {
    // Still short mid-file -> NEVER serve corrupt bytes; let the client retry
    throw new Error(
      "Telegram returned an incomplete media block (short read). Retrying range is safe."
    );
  }

  putBlockLru(blockKey, block);
  return { bytes: block, updatedMeta: currentMeta };
}

export function createTelegramByteRangeStream(params: {
  initialMeta: ResolvedTelegramMediaMeta;
  startByte: number;
  endByte: number;
  abortSignal?: AbortSignal;
}): ReadableStream<Uint8Array> {
  const { startByte, endByte, abortSignal } = params;
  let meta = params.initialMeta;

  const firstAligned =
    Math.floor(startByte / MTPROTO_CHUNK_BYTES) * MTPROTO_CHUNK_BYTES;
  const lastAligned =
    Math.floor(endByte / MTPROTO_CHUNK_BYTES) * MTPROTO_CHUNK_BYTES;

  let nextAlignedToYield = firstAligned;
  let cancelled = false;
  let prefetchPromise: Promise<{
    bytes: Buffer;
    updatedMeta: ResolvedTelegramMediaMeta;
  }> | null = null;

  const triggerBlockFetch = (offset: number) =>
    fetchAligned512KBBlock(meta, offset);

  return new ReadableStream<Uint8Array>({
    start() {
      if (abortSignal) {
        abortSignal.addEventListener(
          "abort",
          () => {
            cancelled = true;
          },
          { once: true }
        );
      }
      if (nextAlignedToYield <= lastAligned) {
        prefetchPromise = triggerBlockFetch(nextAlignedToYield);
      }
    },

    async pull(controller) {
      if (cancelled || abortSignal?.aborted || nextAlignedToYield > lastAligned) {
        try {
          controller.close();
        } catch {
          // ignore
        }
        return;
      }

      try {
        const currentOffset = nextAlignedToYield;
        let currentTask =
          prefetchPromise || triggerBlockFetch(currentOffset);
        prefetchPromise = null;

        const upcomingOffset = currentOffset + MTPROTO_CHUNK_BYTES;
        if (
          !cancelled &&
          !abortSignal?.aborted &&
          upcomingOffset <= lastAligned
        ) {
          prefetchPromise = fetchAligned512KBBlock(meta, upcomingOffset);
          // Avoid "unhandled rejection" if the client disconnects before use
          prefetchPromise.catch(() => undefined);
        }

        // Retry a failing block twice before giving up, so a single Telegram
        // hiccup never truncates the stream (truncation = jumping frames!)
        let bytes: Buffer = Buffer.alloc(0);
        let updatedMeta = meta;
        for (let blockAttempt = 0; blockAttempt < 3; blockAttempt++) {
          try {
            const res = await currentTask;
            bytes = res.bytes;
            updatedMeta = res.updatedMeta;
            break;
          } catch (blockErr) {
            if (blockAttempt === 2) throw blockErr;
            await new Promise((r) => setTimeout(r, 300 * (blockAttempt + 1)));
            currentTask = triggerBlockFetch(currentOffset);
            currentTask.catch(() => undefined);
          }
        }
        meta = updatedMeta;

        if (cancelled || abortSignal?.aborted) {
          prefetchPromise = null;
          try {
            controller.close();
          } catch {
            // ignore
          }
          return;
        }

        if (bytes.length === 0) {
          prefetchPromise = null;
          controller.close();
          return;
        }

        const blockStartInFile = currentOffset;
        const blockEndInFile = currentOffset + bytes.length - 1;

        const sliceStart = Math.max(0, startByte - blockStartInFile);
        const sliceEndExclusive = Math.min(
          bytes.length,
          endByte - blockStartInFile + 1
        );

        if (sliceEndExclusive > sliceStart) {
          const view = bytes.subarray(sliceStart, sliceEndExclusive);
          const out = new Uint8Array(view.length);
          out.set(view);
          controller.enqueue(out);
        }

        nextAlignedToYield += MTPROTO_CHUNK_BYTES;

        const reachedFileEnd =
          blockStartInFile + bytes.length >= meta.totalSize;

        if (
          nextAlignedToYield > lastAligned ||
          blockEndInFile >= endByte ||
          reachedFileEnd
        ) {
          prefetchPromise = null;
          controller.close();
        }
      } catch (err) {
        prefetchPromise = null;
        if (!cancelled && !abortSignal?.aborted) {
          controller.error(err);
        }
      }
    },

    cancel() {
      cancelled = true;
      prefetchPromise = null;
    },
  });
}

/**
 * Thumbnail fetcher: ONLY uses Bot client (if configured) or RAM cache!
 * NEVER opens User `StringSession` so 24 parallel `<img>` tags on a folder page
 * can NEVER spawn competing serverless IPs and trigger `406: AUTH_KEY_DUPLICATED`!
 */
export async function fetchTelegramThumbnailJpeg(params: {
  chatId: string;
  messageId: number;
}): Promise<Buffer | null> {
  const key = `${normalizeChatInput(params.chatId)}_${params.messageId}`;
  const cached = thumbMemoryCache.get(key);
  if (cached) return cached;

  try {
    const creds = await getFastTelegramCredentials();
    if (!creds?.botToken?.trim()) {
      // Do NOT open User StringSession for parallel <img> thumbnails!
      // Route handler cleanly falls back to SITE_CONFIG.defaultImageUrl!
      return null;
    }

    const botClient = await getBotStreamClient(creds);
    if (!botClient) return null;

    const target = resolveEntityTarget(params.chatId);
    const messages = await botClient.getMessages(target, {
      ids: [params.messageId],
    });
    const msg = messages?.[0];
    if (
      !msg ||
      !msg.media ||
      !(msg.media instanceof Api.MessageMediaDocument) ||
      !(msg.media.document instanceof Api.Document)
    ) {
      return null;
    }

    const doc = msg.media.document;
    if (!doc.thumbs || doc.thumbs.length === 0) return null;

    const downloaded = await botClient.downloadMedia(msg.media, {
      thumb: doc.thumbs.length - 1,
    });
    if (!downloaded) return null;

    const buf = Buffer.isBuffer(downloaded)
      ? downloaded
      : typeof downloaded === "string"
      ? Buffer.from(downloaded, "binary")
      : Buffer.from(downloaded as unknown as Uint8Array);
    if (buf.length === 0) return null;

    if (thumbMemoryCache.size > 300) {
      const oldestKey = thumbMemoryCache.keys().next().value;
      if (oldestKey) thumbMemoryCache.delete(oldestKey);
    }
    thumbMemoryCache.set(key, buf);
    return buf;
  } catch {
    return null;
  }
}
