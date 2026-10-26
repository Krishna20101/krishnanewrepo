import "server-only";
import { createTelegramMediaToken } from "./tgCrypto";
import { extractYoutubeId } from "./youtube";
import type { RawBatchFile, RawBatchNode } from "./batchEngine";

export interface ScannedTelegramItem {
  chatId: string;
  messageId: number;
  kind: "VIDEO" | "PDF";
  caption: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  durationSec?: number;
  hasThumb: boolean;
  uploadedAt: string;
  /**
   * TRUE only when the Telegram message actually carries a downloadable file
   * (.mp4 / .pdf). Some lectures are posted as CAPTION-ONLY messages that just
   * contain a YouTube link (class live YouTube par hui thi) — for those
   * `hasMediaFile` is FALSE and `captionYoutubeUrl` holds the link, so the
   * course builder embeds the YouTube player automatically instead of skipping
   * the lecture.
   */
  hasMediaFile: boolean;
  captionYoutubeUrl?: string;
}

export interface ParsedTelegramItem extends ScannedTelegramItem {
  indexNum: number | null;
  cleanTitle: string;
  chapterTitle: string;
  partNumber: number | null;
  subjectName: string;
  programFolder: string;
  batchName: string;
  youtubeUrl: string;
  videoToken?: string;
  pdfToken?: string;
  thumbUrl: string;
}

const SUBJECT_PATTERNS: Array<{ canonical: string; regex: RegExp }> = [
  { canonical: "Chemistry", regex: /\b(chem(istry)?|rasayan)\b|रसायन/i },
  { canonical: "Physics", regex: /\b(phy(sics)?|bhautik(i)?)\b|भौतिक/i },
  {
    canonical: "Biology",
    regex: /\b(bio(logy)?|jiv\s*vigyan|botany|zoology)\b|जीव\s*विज्ञान|बायो/i,
  },
  { canonical: "Mathematics", regex: /\b(math(s|ematics)?|ganit)\b|गणित/i },
  { canonical: "Hindi", regex: /\bhindi\b|हिंदी|हिन्दी/i },
  { canonical: "English", regex: /\b(english|spoken\s*english|grammar)\b|अंग्रेजी/i },
  { canonical: "Sanskrit", regex: /\bsanskrit\b|संस्कृत/i },
  { canonical: "History", regex: /\b(history|itihas)\b|इतिहास/i },
  { canonical: "Geography", regex: /\b(geography|bhugol)\b|भूगोल/i },
  {
    canonical: "Political Science",
    regex: /\b(polity|political|civics)\b|राजनीति/i,
  },
  { canonical: "Economics", regex: /\b(economics|arthshastra)\b|अर्थशास्त्र/i },
  { canonical: "Accountancy", regex: /\b(account(s|ancy)?)\b|लेखाशास्त्र/i },
  {
    canonical: "Business Studies",
    regex: /\b(bst|business\s*studies)\b|व्यवसाय/i,
  },
  { canonical: "Science", regex: /\b(science|vigyan)\b|विज्ञान/i },
  {
    canonical: "Social Science",
    regex: /\b(sst|social\s*science)\b|सामाजिक\s*विज्ञान/i,
  },
];

/**
 * Removes extractor watermarks like `➳ᴹᴿ°Sittu࿐⁰³🦅`, `@channel`, file extensions, etc.,
 * while preserving Devanagari Hindi + English + numbers + punctuation cleanly!
 */
export function cleanWatermarkText(raw: string): string {
  if (!raw) return "";
  let s = raw;

  // Strip "Extracted By: ..." / "Downloaded By: ..." / "@username"
  s = s.replace(
    /(extracted|downloaded|uploaded|powered|shared|credit)\s*by\s*[:\-–—]?.*$/gim,
    ""
  );
  s = s.replace(/@[a-zA-Z0-9_]{3,}/g, "");

  // Strip extractor crash logs that leak into captions, e.g.
  // "Error: 'utf-8' codec can't decode byte 0xe0 in position 6582: ..."
  s = s.replace(
    /\b(error|traceback|exception|warning)\s*[:\-–—].*$/gim,
    ""
  );
  s = s.replace(/['"]?utf-?8['"]?\s+codec.*$/gim, "");

  // Strip trailing "Link: https://youtu.be/xxxx" (link is stored separately!)
  s = s.replace(/\b(?:link|url|watch|video\s*link)\s*[:\-–—]\s*\S+.*$/gim, "");
  s = s.replace(
    /https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/\S+/gi,
    ""
  );

  // Strip file extensions at end
  s = s.replace(/\.(mp4|mkv|webm|mov|avi|flv|m4v|pdf|docx|pptx|zip)\b/gi, "");

  // Remove fancy decorative watermark unicode blocks (arrows, eagles, Tibetan/modifier symbols used in stylish names)
  // Keep: ASCII printable, Devanagari (\u0900-\u097F), general punctuation
  s = s.replace(/[^\x20-\x7E\u0900-\u097F₹•–—]/g, " ");

  // Remove leftover fragments like "MR Sittu 03" if preceded by double spaces or trailing watermark tokens
  s = s.replace(/\bMR\s+[A-Za-z]+\s*\d*\s*$/i, "");

  return s.replace(/\s+/g, " ").trim();
}

/**
 * Finds a YouTube link ANYWHERE in a Telegram caption — including the messy
 * extractor formats below — and returns a canonical watch URL:
 *   Link: https://youtu.be/UxWH-mIFA6E
 *   Link: [https://youtu.be/UxWH-mIFA6E](https://youtu.be/UxWH-mIFA6E)
 *   YouTube: youtu.be/UxWH-mIFA6E      (bina https:// ke bhi!)
 *   <a href="https://www.youtube.com/watch?v=XXXX">
 */
export function extractYoutubeFromText(text: string): string {
  if (!text) return "";

  // 1. Telegram HTML anchor: <a href="https://youtu.be/ID">...</a>
  const anchor = text.match(/href=["']([^"']+)["']/i);
  if (anchor?.[1]) {
    const id = extractYoutubeId(anchor[1]);
    if (id) return `https://www.youtube.com/watch?v=${id}`;
  }

  // 2. Any URL-ish token (protocol optional), markdown brackets stripped
  const candidates = text.match(
    /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|live\/|shorts\/|v\/)|youtu\.be\/)[A-Za-z0-9_-]{6,}[^\s)\]"'<>]*/gi
  );
  if (candidates && candidates.length > 0) {
    for (const raw of candidates) {
      const cleaned = raw.replace(/[\])>.,;]+$/g, "").trim();
      const id = extractYoutubeId(cleaned);
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
  }

  return "";
}

function detectSubject(text: string): string {
  for (const item of SUBJECT_PATTERNS) {
    if (item.regex.test(text)) {
      return item.canonical;
    }
  }
  return "";
}

function extractPartNumber(title: string): number | null {
  const m =
    title.match(
      /(?:\bpart|\blec(?:ture)?|\bclass|\bday|\bep(?:isode)?|भाग|पार्ट)\s*[-–—:#.]*\s*(\d{1,3})\b/i
    ) || title.match(/[-–—]\s*(\d{1,2})\s*$/);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  return Number.isNaN(num) ? null : num;
}

function deriveChapterTitle(cleanTitle: string): string {
  // Strip trailing "PART - 2", "Lecture 03", "भाग 1", etc. so Part 1, Part 2, Part 3 group into one clean Chapter folder!
  let base = cleanTitle
    .replace(
      /\s*[-–—|:(]*\s*(?:part|lec(?:ture)?|class|भाग|पार्ट)\s*[-–—:#.]*\s*\d{1,3}\s*[)]?\s*$/i,
      ""
    )
    .trim();

  base = base.replace(/[-–—:|]+$/, "").trim();
  if (base.length < 3) return cleanTitle;
  return base;
}

export function parseScannedTelegramItem(
  item: ScannedTelegramItem,
  fallbackCourseName: string
): ParsedTelegramItem {
  const lines = (item.caption || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let indexNum: number | null = null;
  let rawTitle = "";
  let rawTopic = "";
  let rawBatch = "";
  let rawSubject = "";
  let rawLink = "";

  for (const line of lines) {
    const idxMatch = line.match(/^(?:index|idx|sr\.?\s*no|s\.?no|id)\s*[:\-–—]\s*(\d+)/i);
    if (idxMatch && indexNum === null) {
      indexNum = parseInt(idxMatch[1], 10);
      continue;
    }

    // "Link: https://youtu.be/XXXX" (caption-only YouTube lectures!)
    const linkMatch = line.match(
      /^(?:link|url|youtube|yt|video\s*link|watch)\s*[:\-–—]\s*(.+)$/i
    );
    if (linkMatch && !rawLink) {
      rawLink = linkMatch[1].trim();
      continue;
    }

    // Extractor crash logs must NEVER become a title/folder name
    if (/^(?:error|traceback|exception|warning)\b/i.test(line)) continue;

    const titleMatch = line.match(/^(?:title|name|lecture|video|pdf|file)\s*[:\-–—]\s*(.+)$/i);
    if (titleMatch && !rawTitle) {
      rawTitle = titleMatch[1].trim();
      continue;
    }

    const topicMatch = line.match(/^(?:topic|folder|chapter|section)\s*[:\-–—]\s*(.+)$/i);
    if (topicMatch && !rawTopic) {
      rawTopic = topicMatch[1].trim();
      continue;
    }

    const subjMatch = line.match(/^(?:subject|sub)\s*[:\-–—]\s*(.+)$/i);
    if (subjMatch && !rawSubject) {
      rawSubject = subjMatch[1].trim();
      continue;
    }

    const batchMatch = line.match(/^(?:batch|course|batch\s*name|course\s*name)\s*[:\-–—]\s*(.+)$/i);
    if (batchMatch && !rawBatch) {
      rawBatch = batchMatch[1].trim();
      continue;
    }
  }

  // Fallback title if caption had no "Title:" prefix
  if (!rawTitle) {
    const firstNonMeta = lines.find(
      (l) =>
        !/^(index|idx|topic|batch|course|subject|link|url|youtube|yt|extracted|downloaded|uploaded|credit|channel|error|traceback|exception|warning|https?:\/\/)/i.test(
          l
        ) && !/'utf-?8'\s+codec/i.test(l)
    );
    rawTitle = firstNonMeta || item.fileName || `${item.kind} #${item.messageId}`;
  }

  const cleanTitle =
    cleanWatermarkText(rawTitle) ||
    cleanWatermarkText(item.fileName) ||
    `Lecture ${indexNum ?? item.messageId}`;

  const cleanTopic = cleanWatermarkText(rawTopic);
  const cleanBatch =
    cleanWatermarkText(rawBatch) ||
    cleanWatermarkText(fallbackCourseName) ||
    "Telegram Synced Course";

  // Parse Topic segments e.g. "Crash Course - 2026 - chemistry"
  let subjectName = cleanWatermarkText(rawSubject);
  let programFolder = "";

  if (cleanTopic) {
    const detectedInTopic = detectSubject(cleanTopic);
    if (!subjectName && detectedInTopic) {
      subjectName = detectedInTopic;
    }
    // Split "Crash Course - 2026 - chemistry" -> programFolder: "Crash Course - 2026", subjectName: "Chemistry"
    const topicParts = cleanTopic
      .split(/\s+-\s+|\s*[|›>/]\s*/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (topicParts.length >= 2) {
      const lastPart = topicParts[topicParts.length - 1];
      const lastSubj = detectSubject(lastPart);
      if (lastSubj) {
        subjectName = lastSubj;
        programFolder = topicParts.slice(0, -1).join(" - ");
      } else if (!subjectName) {
        subjectName =
          lastPart.charAt(0).toUpperCase() + lastPart.slice(1);
        programFolder = topicParts.slice(0, -1).join(" - ");
      }
    } else if (!subjectName) {
      subjectName =
        cleanTopic.charAt(0).toUpperCase() + cleanTopic.slice(1);
    }
  }

  if (!subjectName) {
    subjectName = detectSubject(cleanTitle) || "General Lectures";
  }

  const partNumber = extractPartNumber(cleanTitle);
  const chapterTitle = deriveChapterTitle(cleanTitle);

  // YouTube link priority: explicit "Link:" caption line > anywhere-in-caption scan
  const youtubeUrl =
    extractYoutubeFromText(rawLink) ||
    extractYoutubeFromText(item.caption || "") ||
    (item.captionYoutubeUrl ? extractYoutubeFromText(item.captionYoutubeUrl) : "");

  // A stream token is ONLY possible when the message really carries a file.
  // Caption-only lectures (YouTube classes) have no downloadable Telegram file.
  const hasMediaFile =
    item.hasMediaFile !== false && (item.fileSize > 0 || Boolean(item.fileName));

  const mediaToken = hasMediaFile
    ? createTelegramMediaToken({
        c: item.chatId,
        m: item.messageId,
        k: item.kind === "VIDEO" ? "v" : "p",
        s: item.fileSize,
        n: `${cleanTitle}.${item.kind === "VIDEO" ? "mp4" : "pdf"}`,
        mt:
          item.mimeType ||
          (item.kind === "VIDEO" ? "video/mp4" : "application/pdf"),
      })
    : "";

  const thumbToken =
    hasMediaFile && item.hasThumb
      ? createTelegramMediaToken({
          c: item.chatId,
          m: item.messageId,
          k: "t",
        })
      : "";

  return {
    ...item,
    hasMediaFile,
    indexNum,
    cleanTitle,
    chapterTitle,
    partNumber,
    subjectName,
    programFolder,
    batchName: cleanBatch,
    youtubeUrl,
    videoToken: item.kind === "VIDEO" && mediaToken ? mediaToken : undefined,
    pdfToken: item.kind === "PDF" && mediaToken ? mediaToken : undefined,
    thumbUrl: thumbToken ? `/api/tg/thumb/${thumbToken}` : "",
  };
}

// ============================================================================
// MODE 1: AUTO-BUILD ORGANIZED COURSE JSON FROM TELEGRAM ITEMS
// Groups scattered daily uploads into: Subject -> Chapter -> Ordered Lectures & PDFs
// ============================================================================
export function buildStructuredCourseFromTelegram(params: {
  batchId: string;
  courseTitle?: string;
  price?: string;
  thumbnail?: string;
  items: ParsedTelegramItem[];
}): RawBatchFile {
  const { batchId, courseTitle, price = "0", thumbnail = "", items } = params;

  // Determine most common Batch name from captions if custom title wasn't specified
  const batchFreq = new Map<string, number>();
  for (const it of items) {
    if (it.batchName) {
      batchFreq.set(it.batchName, (batchFreq.get(it.batchName) || 0) + 1);
    }
  }
  let detectedBatchName = courseTitle?.trim() || "";
  if (!detectedBatchName) {
    let bestCount = 0;
    for (const [name, cnt] of Array.from(batchFreq.entries())) {
      if (cnt > bestCount) {
        bestCount = cnt;
        detectedBatchName = name;
      }
    }
  }
  if (!detectedBatchName) detectedBatchName = `Telegram Course ${batchId}`;

  // Sort items chronologically / by Index / Part number first
  const sortedItems = [...items].sort((a, b) => {
    if (a.indexNum !== null && b.indexNum !== null && a.indexNum !== b.indexNum) {
      return a.indexNum - b.indexNum;
    }
    if (
      a.partNumber !== null &&
      b.partNumber !== null &&
      a.partNumber !== b.partNumber
    ) {
      return a.partNumber - b.partNumber;
    }
    return a.messageId - b.messageId;
  });

  // Group into Subject -> Chapter -> Items
  const subjectMap = new Map<
    string,
    Map<string, ParsedTelegramItem[]>
  >();

  for (const item of sortedItems) {
    const subjKey = item.subjectName || "All Subjects";
    if (!subjectMap.has(subjKey)) {
      subjectMap.set(subjKey, new Map());
    }
    const chapMap = subjectMap.get(subjKey)!;
    const chapKey = item.chapterTitle || "Lectures";
    if (!chapMap.has(chapKey)) {
      chapMap.set(chapKey, []);
    }
    chapMap.get(chapKey)!.push(item);
  }

  const subjectNodes: RawBatchNode[] = [];
  let subjIdx = 1;

  for (const [subjectTitle, chapMap] of Array.from(subjectMap.entries())) {
    const subjectFolderId = `tg_${batchId}_subj_${subjIdx++}`;
    const chapterNodes: RawBatchNode[] = [];
    let chapIdx = 1;
    let subjectThumb = "";

    // Sort chapters naturally by leading number if present (e.g. "1. ठोस अवस्था", "2. विलयन")
    const sortedChapters = Array.from(chapMap.entries()).sort(([cA], [cB]) => {
      const nA = parseInt(cA.match(/^(\d+)/)?.[1] || "9999", 10);
      const nB = parseInt(cB.match(/^(\d+)/)?.[1] || "9999", 10);
      if (nA !== nB) return nA - nB;
      return cA.localeCompare(cB, "hi");
    });

    for (const [chapterTitle, chapItems] of sortedChapters) {
      const chapFolderId = `${subjectFolderId}_chap_${chapIdx++}`;

      const videos = chapItems
        .filter((x) => x.kind === "VIDEO")
        .sort((a, b) => {
          if (
            a.partNumber !== null &&
            b.partNumber !== null &&
            a.partNumber !== b.partNumber
          ) {
            return a.partNumber - b.partNumber;
          }
          if (a.indexNum !== null && b.indexNum !== null) {
            return a.indexNum - b.indexNum;
          }
          return a.messageId - b.messageId;
        });

      const pdfs = chapItems
        .filter((x) => x.kind === "PDF")
        .sort((a, b) => {
          if (
            a.partNumber !== null &&
            b.partNumber !== null &&
            a.partNumber !== b.partNumber
          ) {
            return a.partNumber - b.partNumber;
          }
          return a.messageId - b.messageId;
        });

      const childrenNodes: RawBatchNode[] = [];
      let chapterThumb = "";

      for (const vid of videos) {
        if (!chapterThumb && vid.thumbUrl) chapterThumb = vid.thumbUrl;
        if (!subjectThumb && vid.thumbUrl) subjectThumb = vid.thumbUrl;

        // Check if there is a matching PDF for this exact video (e.g. Part-2.mp4 + Part-2.pdf)
        const pairedPdf = pdfs.find(
          (p) =>
            normalizeForComparison(p.cleanTitle) ===
              normalizeForComparison(vid.cleanTitle) ||
            (vid.partNumber !== null &&
              p.partNumber === vid.partNumber &&
              normalizeForComparison(p.chapterTitle) ===
                normalizeForComparison(vid.chapterTitle))
        );

        childrenNodes.push({
          id: `tgv_${vid.messageId}`,
          parent_id: chapFolderId,
          title: vid.cleanTitle,
          type: "VIDEO",
          thumbnail: vid.thumbUrl || "",
          uploaded_at: vid.uploadedAt,
          youtube_url: vid.youtubeUrl || undefined,
          tg_video_token: vid.videoToken,
          tg_pdf_token: pairedPdf?.pdfToken || undefined,
          pdf_link_enc: pairedPdf?.pdfToken ? "tg_attached" : undefined,
          file_size: vid.fileSize,
          duration_sec: vid.durationSec,
        });
      }

      for (const pdf of pdfs) {
        childrenNodes.push({
          id: `tgp_${pdf.messageId}`,
          parent_id: chapFolderId,
          title: pdf.cleanTitle,
          type: "PDF",
          thumbnail: "",
          uploaded_at: pdf.uploadedAt,
          tg_pdf_token: pdf.pdfToken,
          pdf_link_enc: "tg_attached",
          file_size: pdf.fileSize,
        });
      }

      chapterNodes.push({
        id: chapFolderId,
        parent_id: subjectFolderId,
        title: chapterTitle,
        type: "FOLDER",
        thumbnail: chapterThumb,
        videos_count: videos.length,
        files_count: pdfs.length,
        children: childrenNodes,
      });
    }

    const subjVideoTotal = chapterNodes.reduce(
      (s, c) => s + (c.videos_count || 0),
      0
    );
    const subjPdfTotal = chapterNodes.reduce(
      (s, c) => s + (c.files_count || 0),
      0
    );

    subjectNodes.push({
      id: subjectFolderId,
      parent_id: "-1",
      title: subjectTitle,
      type: "FOLDER",
      thumbnail: subjectThumb,
      videos_count: subjVideoTotal,
      files_count: subjPdfTotal,
      children: chapterNodes,
    });
  }

  const firstCourseThumb =
    thumbnail.trim() ||
    subjectNodes.find((s) => s.thumbnail)?.thumbnail ||
    "";

  return {
    source: "telegram_auto_sync",
    id: batchId,
    name: detectedBatchName,
    thumbnail: firstCourseThumb,
    price,
    scraped_at: new Date().toISOString(),
    item_count: items.length,
    tree: subjectNodes,
  };
}

// ============================================================================
// MODE 2: SMART DEEP-TREE FUZZY MERGER INTO EXISTING JSON BATCHES
// Handles arbitrary extra nested folders (e.g. 2027 -> Recorded 2026 -> Subject -> Batch -> Video)
// ============================================================================
function normalizeForComparison(text: string): string {
  if (!text) return "";
  let s = cleanWatermarkText(text).toLowerCase();
  // Normalize part/lecture tokens so "PART -2", "Part 02", "part-2" all become "part_2"
  s = s.replace(
    /(?:\bpart|\blec(?:ture)?|\bclass|भाग|पार्ट)\s*[-–—:#.]*\s*0*(\d+)\b/gi,
    " part_$1 "
  );
  // Keep letters, digits, Devanagari
  s = s.replace(/[^a-zA-Z0-9\u0900-\u097F_]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function computeTitleSimilarity(
  tgItem: ParsedTelegramItem,
  jsonTitle: string,
  ancestorPathText: string
): number {
  const normTg = normalizeForComparison(tgItem.cleanTitle);
  const normJson = normalizeForComparison(jsonTitle);
  if (!normTg || !normJson) return 0;

  // Hard guard: never cross-match Part-1 with Part-2!
  const jsonPart = extractPartNumber(jsonTitle);
  if (
    tgItem.partNumber !== null &&
    jsonPart !== null &&
    tgItem.partNumber !== jsonPart
  ) {
    return 0;
  }

  // Hard guard: prevent Physics item matching inside a Chemistry folder!
  const jsonSubject = detectSubject(`${ancestorPathText} ${jsonTitle}`);
  if (
    tgItem.subjectName &&
    tgItem.subjectName !== "General Lectures" &&
    jsonSubject &&
    tgItem.subjectName !== jsonSubject
  ) {
    return 0;
  }

  let baseScore = 0;
  if (normTg === normJson) {
    baseScore = 96;
  } else if (
    (normTg.length >= 6 && normJson.includes(normTg)) ||
    (normJson.length >= 6 && normTg.includes(normJson))
  ) {
    baseScore = 84;
  } else {
    const tokensA = new Set(normTg.split(" ").filter((w) => w.length >= 2));
    const tokensB = new Set(normJson.split(" ").filter((w) => w.length >= 2));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let overlap = 0;
    for (const t of Array.from(tokensA)) {
      if (tokensB.has(t)) overlap++;
    }
    const union = new Set([
      ...Array.from(tokensA),
      ...Array.from(tokensB),
    ]).size;
    const jaccard = overlap / union;
    const containment = overlap / Math.min(tokensA.size, tokensB.size);
    baseScore = Math.round((jaccard * 0.55 + containment * 0.45) * 100);
  }

  // Subject folder bonus
  if (jsonSubject && tgItem.subjectName === jsonSubject) {
    baseScore = Math.min(100, baseScore + 8);
  }

  return baseScore;
}

export function mergeTelegramItemsIntoExistingBatch(
  batch: RawBatchFile,
  items: ParsedTelegramItem[]
): {
  updatedBatch: RawBatchFile;
  matchedVideos: number;
  matchedPdfs: number;
} {
  const cloned: RawBatchFile = JSON.parse(JSON.stringify(batch));
  let matchedVideos = 0;
  let matchedPdfs = 0;

  interface FlatLeafRef {
    node: RawBatchNode;
    ancestorPath: string;
  }

  const videoRefs: FlatLeafRef[] = [];
  const pdfRefs: FlatLeafRef[] = [];

  function walk(nodes: RawBatchNode[], pathTitles: string[]) {
    for (const n of nodes) {
      const t = String(n.type || "").toUpperCase();
      const title = String(n.title || n.name || "");
      if (t === "VIDEO") {
        videoRefs.push({ node: n, ancestorPath: pathTitles.join(" > ") });
      } else if (t === "PDF") {
        pdfRefs.push({ node: n, ancestorPath: pathTitles.join(" > ") });
      }
      if (Array.isArray(n.children) && n.children.length > 0) {
        walk(n.children, [...pathTitles, title]);
      }
    }
  }

  walk(cloned.tree || [], [String(cloned.name || "")]);

  for (const tgItem of items) {
    if (tgItem.kind === "VIDEO") {
      let bestRef: FlatLeafRef | null = null;
      let bestScore = 0;

      for (const ref of videoRefs) {
        const sc = computeTitleSimilarity(
          tgItem,
          String(ref.node.title || ref.node.name || ""),
          ref.ancestorPath
        );
        if (sc > bestScore) {
          bestScore = sc;
          bestRef = ref;
        }
      }

      if (bestRef && bestScore >= 65) {
        // NEVER wipe an existing working stream token with `undefined`
        if (tgItem.videoToken) {
          bestRef.node.tg_video_token = tgItem.videoToken;
        }
        if (!bestRef.node.thumbnail && tgItem.thumbUrl) {
          bestRef.node.thumbnail = tgItem.thumbUrl;
        }
        // Caption-only YouTube lectures (no .mp4 in Telegram) get auto-embedded!
        if (tgItem.youtubeUrl && !bestRef.node.youtube_url) {
          bestRef.node.youtube_url = tgItem.youtubeUrl;
        }
        if (tgItem.fileSize > 0) {
          bestRef.node.file_size = tgItem.fileSize;
        }
        matchedVideos++;
      }
    } else if (tgItem.kind === "PDF") {
      // Match against standalone PDF nodes
      let bestPdfRef: FlatLeafRef | null = null;
      let bestPdfScore = 0;
      for (const ref of pdfRefs) {
        const sc = computeTitleSimilarity(
          tgItem,
          String(ref.node.title || ref.node.name || ""),
          ref.ancestorPath
        );
        if (sc > bestPdfScore) {
          bestPdfScore = sc;
          bestPdfRef = ref;
        }
      }
      if (bestPdfRef && bestPdfScore >= 65 && bestPdfRef.node && tgItem.pdfToken) {
        bestPdfRef.node.tg_pdf_token = tgItem.pdfToken;
        bestPdfRef.node.pdf_link_enc = "tg_attached";
        if (tgItem.fileSize > 0) bestPdfRef.node.file_size = tgItem.fileSize;
        matchedPdfs++;
      }

      // Also attach PDF button to matching Lecture VIDEO node!
      let bestVidRef: FlatLeafRef | null = null;
      let bestVidScore = 0;
      for (const ref of videoRefs) {
        const sc = computeTitleSimilarity(
          tgItem,
          String(ref.node.title || ref.node.name || ""),
          ref.ancestorPath
        );
        if (sc > bestVidScore) {
          bestVidScore = sc;
          bestVidRef = ref;
        }
      }
      if (bestVidRef && bestVidScore >= 68 && tgItem.pdfToken) {
        bestVidRef.node.tg_pdf_token = tgItem.pdfToken;
        bestVidRef.node.pdf_link_enc = "tg_attached";
        if (!bestPdfRef || bestPdfScore < 65) {
          matchedPdfs++;
        }
      }
    }
  }

  return { updatedBatch: cloned, matchedVideos, matchedPdfs };
}
