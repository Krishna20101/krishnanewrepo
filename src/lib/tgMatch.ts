// ============================================================================
// STUDY HELPER DOC — CAPTION PARSER + SMART MATCH ENGINE  (TypeScript mirror)
// ----------------------------------------------------------------------------
// Python bot ka exact mirror: telegram-bot/matcher.py
// Dono jagah SAME rules hain taaki:
//   • website sync jo title/course/topic banata hai
//   • bot jo video search karke match karta hai
// dono consistent rahein.
//
// Rules (user spec):
//   1) @username / t.me link caption me KABHI nahi rehna chahiye (mandatory)
//   2) "Extracted By" jaisa plain text reh sakta hai, handle nahi
//   3) COURSE NAME match MANDATORY — main keys (12th / मंजिल / Crash Course /
//      NEET / 2027 …) alag hue to candidate REJECT
//   4) Title/Topic field order kuch bhi ho (upar-neeche) — sab padha jata hai
//   5) 2 channel me same video ho → SIRF BEST MATCH (duplicate kabhi nahi)
//   6) Part 1 kabhi Part 2 se match na ho (hard guard)
// ============================================================================

/** Minimum combined score (0-100) to accept a candidate. */
export const MATCH_THRESHOLD = 60;
/** Minimum course score (0-1) — course name match MANDATORY. */
export const COURSE_MIN = 0.34;

export interface ParsedCaption {
  title: string;
  topic: string;
  course: string;
  subject: string;
  index: number | null;
  part: number | null;
  youtubeUrl: string;
  raw: string;
}

export interface MatchRequest {
  title?: string;
  topic?: string;
  courseName?: string;
  fileSize?: number;
  part?: number | null;
}

export interface MatchCandidate {
  caption?: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
  chatId?: string | number;
  chatTitle?: string;
  messageId?: number;
  [key: string]: unknown;
}

export interface MatchResult extends MatchCandidate {
  score: number;
  reason: string;
  titleSim: number;
  topicSim: number;
  courseScore: number;
  parsed: ParsedCaption;
}

// ── Label patterns (order-independent) ─────────────────────────────────────
const LABEL_PATTERNS: Record<string, RegExp> = {
  index: /^(?:index|idx|sr\.?\s*no|s\.?no|no\.?|id|संख्या|क्रमांक)$/i,
  title:
    /^(?:title|name|video\s*name|class\s*name|lecture\s*name|file\s*name|lecture|video|class|pdf|file|शीर्षक|नाम|क्लास|वीडियो|लेक्चर)$/i,
  topic:
    /^(?:topic|chapter|section|folder|sub\s*topic|syllabus|टॉपिक|विषय\s*वस्तु|अध्याय|प्रकरण)$/i,
  course: /^(?:batch|course|batch\s*name|course\s*name|program|programme|बैच|कोर्स|पाठ्यक्रम)$/i,
  subject: /^(?:subject|sub|विषय)$/i,
  link: /^(?:link|url|youtube|yt|video\s*link|watch|लिंक)$/i,
  date: /^(?:date|uploaded|time|posted|दिनांक|तारीख)$/i,
};

const LABEL_LINE_RE =
  /^((?:index|idx|sr\.?\s*no|s\.?no|no\.?|id|title|name|video\s*name|class\s*name|lecture\s*name|file\s*name|lecture|video|class|pdf|file|topic|chapter|section|folder|sub\s*topic|syllabus|batch|course|batch\s*name|course\s*name|program|programme|subject|sub|link|url|youtube|yt|video\s*link|watch|date|uploaded|time|posted|शीर्षक|नाम|क्लास|वीडियो|लेक्चर|टॉपिक|अध्याय|प्रकरण|बैच|कोर्स|पाठ्यक्रम|विषय|संख्या|क्रमांक|दिनांक|तारीख|लिंक))\s*[:\-–—]\s*(.+)$/i;

/** GRADE keys — 12th / 11th / class 10 (alag hue = course alag = REJECT) */
const GRADE_KEY_RE =
  /(?:\b(?:9|10|11|12)\s*(?:th|वीं|वी)\b|\bclass\s*\d{1,2}\b|\b\d{1,2}\s*वीं\b)/gi;

/** STRONG keys — batch/program ke asli naam (alag hue = REJECT) */
const STRONG_KEY_RE =
  /(?:\bcrash\s*course\b|\bfoundation\b|\btarget\b|\bmanzil\b|मंजिल|\bparivartan\b|परिवर्तन|\budaan\b|उड़ान|\bsankalp\b|संकल्प|\bnucleus\b|आरंभ|\barambh\b|\bpragati\b|प्रगति|\bjee\b|\bneet\b|\baiims\b|\bcuqet\b|\bbiceps\b|\bboards?\b|\bpre[\s-]?boards?\b|\bolympiad\b|\bspoken\s*english\b|\benglish\s*(?:batch|course)\b|\bgrammar\b|\bcomplete\s*batch\b|\bfull\s*course\b|\brecorded\b|\blive\b)/gi;

/** WEAK keys — sirf bonus, reject nahi karte */
const WEAK_KEY_RE =
  /(?:\bbatch\b|बैच|\bcourse\b|कोर्स|\bprograms?\b|\b20\d{2}\b|\bhindi\b|हिंदी|हिन्दी|\benglish\b|अंग्रेजी|\bmedium\b|\bscience\b|विज्ञान|\bcommerce\b|वाणिज्य|\barts\b|\bhumanities\b|\bstream\b)/gi;

const USERNAME_RE = /(?<!\w)@\w{3,32}(?!\w)/g;
const TG_LINK_RE = /(?:https?:\/\/)?(?:t\.me|telegram\.(?:me|org|dog))[:/][\w/+.\-]+/gi;
const EXTRACTOR_LINE_RE =
  /^\s*(?:extracted|downloaded|uploaded|shared|powered|posted|credit|source|from|channel|group)\s*(?:by|to|from)?\s*[:\-–—]?\s*.*$/i;
const ERROR_LOG_RE =
  /(?:\berror\b|\btraceback\b|\bexception\b|\bwarning\b|['"]?utf-?8['"]?\s*codec|can'?t\s+decode|yt-?dlp|ffmpeg|extractor)/i;
const YOUTUBE_RE =
  /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|live\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i;
const FILE_EXT_RE = /\.(mp4|mkv|webm|mov|avi|flv|m4v|ts|pdf|docx|pptx|zip|rar)\b/gi;
const DECOR_RE = /[^\x20-\x7E\u0900-\u097F₹•–—…]+/g;
const PART_RE =
  /(?:\bpart|\blec(?:ture)?|\bclass|\bday|\bep(?:isode)?|\bभाग|\bपार्ट|\bखंड)\s*[-–—:#.]*\s*0*(\d{1,3})\b/gi;

// ────────────────────────────────────────────────────────────────────────────
// CLEANING
// ────────────────────────────────────────────────────────────────────────────
/** @username + t.me links hata deta hai (MANDATORY rule). */
export function stripUsernames(text: string): string {
  if (!text) return "";
  return String(text)
    .replace(TG_LINK_RE, " ")
    .replace(USERNAME_RE, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Caption/title ko display-safe banata hai (watermark, logs, @handle). */
export function cleanCaptionText(raw: string, dropExtractorLines = true): string {
  if (!raw) return "";
  let s = String(raw).replace(/\r\n/g, "\n");
  s = stripUsernames(s);

  const lines: string[] = [];
  for (const line of s.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (ERROR_LOG_RE.test(trimmed)) continue;
    if (dropExtractorLines && EXTRACTOR_LINE_RE.test(trimmed)) continue;
    lines.push(trimmed);
  }

  s = lines.join("\n");
  s = s.replace(FILE_EXT_RE, "");
  s = s.replace(DECOR_RE, " ");
  s = s.replace(/[ \t]{2,}/g, " ");
  return s.replace(/^[ \t\-–—:|•\n]+|[ \t\-–—:|•\n]+$/g, "").trim();
}

/** Compare ke liye canonical form. */
export function normalizeForMatch(text: string): string {
  if (!text) return "";
  let s = String(text)
    .normalize("NFKC")
    .toLowerCase();
  s = stripUsernames(s);
  s = s.replace(PART_RE, (_m, n: string) => ` part ${parseInt(n, 10)} `);
  s = s.replace(FILE_EXT_RE, " ");
  s = s.replace(/[^0-9a-z\u0900-\u097F]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

export function tokenizeForMatch(text: string): string[] {
  return normalizeForMatch(text)
    .split(" ")
    .filter(Boolean);
}

export function extractPartNumber(text: string): number | null {
  if (!text) return null;
  PART_RE.lastIndex = 0;
  const m = PART_RE.exec(text);
  if (m) return parseInt(m[1], 10);
  const tail = text.trim().match(/[-–—]\s*0*(\d{1,3})\s*$/);
  return tail ? parseInt(tail[1], 10) : null;
}

function charBigrams(s: string): Set<string> {
  const compact = s.replace(/ /g, "");
  const out = new Set<string>();
  if (compact.length <= 1) {
    if (compact) out.add(compact);
    return out;
  }
  for (let i = 0; i < compact.length - 1; i += 1) out.add(compact.slice(i, i + 2));
  return out;
}

/** 0-1 fuzzy similarity (Hindi/Devanagari + English). */
export function similarity(a: string, b: string): number {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length >= 6 && (na.includes(nb) || nb.includes(na))) return 0.9;

  const ta = new Set(tokenizeForMatch(na));
  const tb = new Set(tokenizeForMatch(nb));
  if (!ta.size || !tb.size) return 0;

  let inter = 0;
  ta.forEach((t) => {
    if (tb.has(t)) inter += 1;
  });
  const union = new Set([...ta, ...tb]).size;
  const jaccard = inter / union;
  const containment = inter / Math.min(ta.size, tb.size);

  const ba = charBigrams(na);
  const bb = charBigrams(nb);
  let dice = 0;
  if (ba.size && bb.size) {
    let shared = 0;
    ba.forEach((x) => {
      if (bb.has(x)) shared += 1;
    });
    dice = (2 * shared) / (ba.size + bb.size);
  }

  return Math.round((jaccard * 0.5 + containment * 0.28 + dice * 0.22) * 10000) / 10000;
}

function keySet(pattern: RegExp, text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    const key = normalizeForMatch(m[0]);
    if (key) out.add(key);
    m = re.exec(text);
  }
  return out;
}

/** Course ke "main keys" (grade + strong) — यही match hona MANDATORY hai. */
export function informativeCourseKeys(text: string): Set<string> {
  const keys = keySet(GRADE_KEY_RE, text || "");
  keySet(STRONG_KEY_RE, text || "").forEach((k) => keys.add(k));
  return keys;
}

/** Saare course keys (diagnostics ke liye). */
export function courseKeys(text: string): Set<string> {
  const keys = informativeCourseKeys(text);
  keySet(WEAK_KEY_RE, text || "").forEach((k) => keys.add(k));
  const norm = normalizeForMatch(text || "");
  const yearRe = /\b(20\d{2})\b/g;
  let m = yearRe.exec(norm);
  while (m) {
    keys.add(m[1]);
    m = yearRe.exec(norm);
  }
  return keys;
}

/** COURSE NAME match — MANDATORY rule. */
export function courseMatchScore(a: string, b: string): number {
  const ia = informativeCourseKeys(a);
  const ib = informativeCourseKeys(b);

  if (!ia.size && !ib.size) return Math.round(similarity(a, b) * 0.75 * 10000) / 10000;

  if (!ia.size || !ib.size) {
    const base = similarity(a, b);
    return base >= 0.6 ? Math.round(base * 0.5 * 10000) / 10000 : 0;
  }

  const ga = keySet(GRADE_KEY_RE, a || "");
  const gb = keySet(GRADE_KEY_RE, b || "");
  if (ga.size && gb.size && ![...ga].some((x) => gb.has(x))) return 0;

  const sa = keySet(STRONG_KEY_RE, a || "");
  const sb = keySet(STRONG_KEY_RE, b || "");
  if (sa.size && sb.size && ![...sa].some((x) => sb.has(x))) return 0;

  const shared = [...ia].filter((x) => ib.has(x));
  if (!shared.length) return 0;
  const union = new Set([...ia, ...ib]).size;
  const base = shared.length / Math.max(1, union);
  return Math.round(Math.min(1, base * 0.75 + similarity(a, b) * 0.25) * 10000) / 10000;
}

// ────────────────────────────────────────────────────────────────────────────
// CAPTION PARSING (order-independent)
// ────────────────────────────────────────────────────────────────────────────
function labelKey(label: string): string {
  const lab = label.trim();
  for (const [key, pattern] of Object.entries(LABEL_PATTERNS)) {
    if (pattern.test(lab)) return key;
  }
  return "";
}

export function parseTelegramCaption(caption: string, fileName = ""): ParsedCaption {
  const raw = (caption || "").replace(/\r\n/g, "\n");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const found: Record<string, string> = {};
  let indexNum: number | null = null;
  let youtube = "";
  const rest: string[] = [];

  for (const line of lines) {
    const yt = line.match(YOUTUBE_RE);
    if (yt && !youtube) youtube = `https://www.youtube.com/watch?v=${yt[1]}`;

    const m = line.match(LABEL_LINE_RE);
    if (m) {
      const key = labelKey(m[1]);
      const value = (m[2] || "").trim();
      if (key === "index") {
        const digits = value.replace(/\D/g, "");
        if (digits && indexNum === null) indexNum = parseInt(digits.slice(0, 6), 10);
        continue;
      }
      if (key === "link") continue;
      if (key && value) {
        found[key] = found[key] ? `${found[key]} ${value}` : value;
        continue;
      }
    }
    rest.push(line);
  }

  let topicGuess = "";
  let courseGuess = "";
  let titleGuess = "";
  for (const line of rest) {
    if (ERROR_LOG_RE.test(line) || EXTRACTOR_LINE_RE.test(line)) continue;
    const hasCourseKey = new RegExp(COURSE_KEY_RE_SOURCE(), "i").test(line);
    const hasPart = new RegExp(PART_RE.source, "i").test(line);
    if (hasCourseKey && !courseGuess && !hasPart) {
      courseGuess = line;
      continue;
    }
    if (hasCourseKey && hasPart && !titleGuess) {
      titleGuess = line;
      if (!courseGuess) courseGuess = line;
      continue;
    }
    if (!titleGuess) titleGuess = line;
    else if (!topicGuess) topicGuess = line;
  }

  let title = cleanCaptionText(found.title || titleGuess || fileName || "");
  if (!title && fileName) title = cleanCaptionText(fileName);

  const topic = cleanCaptionText(found.topic || topicGuess);
  const course = cleanCaptionText(found.course || courseGuess);
  const subject = cleanCaptionText(found.subject || "");

  return {
    title,
    topic,
    course,
    subject,
    index: indexNum,
    part: extractPartNumber(title || topic),
    youtubeUrl: youtube,
    raw,
  };
}

function COURSE_KEY_RE_SOURCE(): string {
  return `(?:${GRADE_KEY_RE.source}|${STRONG_KEY_RE.source}|${WEAK_KEY_RE.source})`;
}

// ────────────────────────────────────────────────────────────────────────────
// SCORING + DEDUPE
// ────────────────────────────────────────────────────────────────────────────
export function scoreMatch(request: MatchRequest, candidate: MatchCandidate): MatchResult {
  const parsed = parseTelegramCaption(
    String(candidate.caption || ""),
    String(candidate.fileName || "")
  );

  const reqTitle = request.title || "";
  const reqTopic = request.topic || "";
  const reqCourse = request.courseName || "";

  const cTitle = parsed.title || String(candidate.fileName || "");
  const cTopic = parsed.topic;
  const cCourse = parsed.course || String(candidate.chatTitle || "");

  const titleSim = similarity(reqTitle, cTitle);
  let topicSim = reqTopic && cTopic ? similarity(reqTopic, cTopic) : 0;
  if (reqTopic && !cTopic) topicSim = similarity(reqTopic, cTitle) * 0.6;
  const courseScore = courseMatchScore(reqCourse, cCourse);

  const reqPart = request.part ?? extractPartNumber(reqTitle);
  const cPart = parsed.part ?? extractPartNumber(cTitle);

  const base: MatchResult = {
    ...candidate,
    score: 0,
    reason: "",
    titleSim: Math.round(titleSim * 1000) / 1000,
    topicSim: Math.round(topicSim * 1000) / 1000,
    courseScore: Math.round(courseScore * 1000) / 1000,
    parsed,
  };

  if (reqPart && cPart && Number(reqPart) !== Number(cPart)) {
    return { ...base, reason: `part-mismatch (part ${reqPart} vs part ${cPart})` };
  }
  if (courseScore < COURSE_MIN) {
    return { ...base, reason: "course-name mismatch (mandatory rule)" };
  }

  let score = 100 * (0.5 * titleSim + 0.18 * topicSim + 0.32 * courseScore);

  const reqSize = Number(request.fileSize || 0);
  const cSize = Number(candidate.fileSize || 0);
  if (reqSize && cSize) {
    const ratio = Math.min(reqSize, cSize) / Math.max(reqSize, cSize);
    if (ratio > 0.97) score += 6;
    else if (ratio < 0.5) score -= 8;
  }

  return {
    ...base,
    score: Math.round(Math.min(100, score) * 100) / 100,
    reason: `title=${titleSim.toFixed(2)} topic=${topicSim.toFixed(2)} course=${courseScore.toFixed(2)}`,
  };
}

/** Same video 2 channel me ho → SIRF best match rakhta hai. */
export function dedupeCandidates<T extends MatchResult>(candidates: T[]): T[] {
  const best = new Map<string, T>();
  for (const cand of candidates) {
    const keyTitle = normalizeForMatch(cand.parsed?.title || String(cand.fileName || "")).slice(0, 60);
    const sizeMb = Math.round(Number(cand.fileSize || 0) / (1024 * 1024));
    const dur = Math.round(Number(cand.duration || 0) / 15);
    const key = `${keyTitle}|${sizeMb}|${dur}`;
    const prev = best.get(key);
    if (!prev || Number(cand.score || 0) > Number(prev.score || 0)) best.set(key, cand);
  }
  return [...best.values()].sort(
    (a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.fileSize || 0) - Number(a.fileSize || 0)
  );
}

export function pickBestCandidate<T extends MatchResult>(candidates: T[]): T | null {
  for (const cand of dedupeCandidates(candidates)) {
    if (Number(cand.score || 0) >= MATCH_THRESHOLD) return cand;
  }
  return null;
}

/** Telegram server-side search ke liye chhoti distinctive query. */
export function searchQuery(title: string, topic = ""): string {
  let base = cleanCaptionText(title);
  base = base.replace(/\b(?:part|lecture|class)\b\s*[-–—:#.]*\s*\d{1,3}\b/gi, " ");
  let words = tokenizeForMatch(base)
    .filter((w) => w.length >= 3)
    .slice(0, 5);
  if (!words.length) {
    words = tokenizeForMatch(topic)
      .filter((w) => w.length >= 3)
      .slice(0, 4);
  }
  return words.join(" ").slice(0, 90).trim();
}

/** Folder-wise topic path: "Chemistry › Solid State › Part 1" */
export function buildTopicPath(folderPath?: string[] | string, topic?: string): string {
  const parts: string[] = [];
  if (Array.isArray(folderPath)) {
    for (const p of folderPath) {
      const clean = cleanCaptionText(String(p || ""));
      if (clean) parts.push(clean);
    }
  } else if (typeof folderPath === "string" && folderPath) {
    for (const p of folderPath.split(">")) {
      const clean = cleanCaptionText(p);
      if (clean) parts.push(clean);
    }
  }
  const cleanTopic = cleanCaptionText(topic || "");
  if (cleanTopic && !parts.some((p) => p.toLowerCase() === cleanTopic.toLowerCase())) {
    parts.push(cleanTopic);
  }

  const seen: string[] = [];
  for (const part of parts) {
    if (!seen.some((s) => s.toLowerCase() === part.toLowerCase())) seen.push(part);
  }
  return seen.slice(0, 4).join(" › ");
}

/** Delivery caption ka website-side preview (bot wala exact format). */
export function buildDeliveryCaptionPreview(params: {
  title: string;
  topic?: string;
  course?: string;
  creditUsername?: string;
}): string {
  const title = cleanCaptionText(params.title).slice(0, 180) || "Lecture";
  const topic = cleanCaptionText(params.topic || "").slice(0, 160);
  const course = cleanCaptionText(params.course || "").slice(0, 160);
  const credit = String(params.creditUsername || "krishna84").replace(/^@+/, "").slice(0, 32);

  const lines = [`📺 ${title}`];
  if (topic) lines.push(`📚 Topic: ${topic}`);
  if (course) lines.push(`🎓 Course: ${course}`);
  lines.push("");
  lines.push(`Extracted By @${credit}`);

  const caption = lines.join("\n");
  return caption.length > 1000 ? `${caption.slice(0, 1000).trimEnd()}…` : caption;
}
