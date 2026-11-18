#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
===============================================================================
 STUDY HELPER DOC — CAPTION PARSER + SMART MATCH ENGINE  (matcher.py)
===============================================================================
 Ye file "dimag" hai. Telegram captions bahut alag-alag format me aate hain:

   Format A                     Format B                    Format C (bina label)
   -------------------------    -------------------------   --------------------------
   Index: 42                    Topic: Solid State          12th मंजिल बैच 2027
   Title: Solid State Part 1    Course: 12th मंजिल बैच      Chemistry - Solid State
   Batch: 12th मंजिल बैच        Title: Solid State Part 1   Part 1 (Full Chapter)
   Topic: Chemistry             Subject: Chemistry          Extracted By: @somechannel

 Isliye:
   1) parse_caption()  → label wale fields order-independent padhta hai, aur
                         bina label wale lines ko heuristic se classify karta hai.
   2) strip_usernames()→ @username / t.me links / extractor watermarks HAMESHA
                         hatata hai (mandatory rule: @username kabhi nahi dikhna
                         chahiye, "Extracted By" text reh sakta hai).
   3) course_match_score() → COURSE NAME match MANDATORY hai. Main keys
                         (12th / 11th / बैच / मंजिल / Crash Course / NEET / 2027 ...)
                         match na ho to candidate REJECT (score 0).
   4) score_candidate() → title + topic + course ka weighted score (0-100).
   5) dedupe_candidates() → 2 channel me same video mile to SIRF BEST match chunta
                         hai (duplicate kabhi send nahi hota).

 Website side (TypeScript) me iska exact mirror hai: src/lib/tgMatch.ts
 Dono jagah same rules hain taaki sync aur delivery consistent rahein.

 Self-test:  python3 matcher.py
===============================================================================
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS / RULES
# ─────────────────────────────────────────────────────────────────────────────

#: Minimum combined score (0-100) to accept a candidate video.
MATCH_THRESHOLD = 60.0

#: Minimum course score (0-1) — course name match is MANDATORY.
COURSE_MIN = 0.34

#: Labels that can appear in a caption (order does NOT matter).
LABELS = {
    "index": r"(?:index|idx|sr\.?\s*no|s\.?no|no\.?|id|संख्या|क्रमांक)",
    "title": (
        r"(?:title|name|video\s*name|class\s*name|lecture\s*name|file\s*name|"
        r"lecture|video|class|pdf|file|शीर्षक|नाम|क्लास|वीडियो|लेक्चर)"
    ),
    "topic": (
        r"(?:topic|chapter|section|folder|sub\s*topic|syllabus|"
        r"टॉपिक|विषय\s*वस्तु|अध्याय|प्रकरण)"
    ),
    "course": (
        r"(?:batch|course|batch\s*name|course\s*name|program|programme|"
        r"बैच|कोर्स|पाठ्यक्रम)"
    ),
    "subject": r"(?:subject|sub|विषय)",
    "link": r"(?:link|url|youtube|yt|video\s*link|watch|लिंक)",
    "date": r"(?:date|uploaded|time|posted|दिनांक|तारीख)",
}

#: "Main keys" — ye course name ke pehchaan chinha hain (user rule: same course
#: name MANDATORY). Teen tiers hain:
#:   GRADE  → 12th / 11th / class 10   (dono taraf ho aur alag ho = REJECT)
#:   STRONG → मंजिल / परिवर्तन / Crash Course / NEET / Spoken English ...
#:            (dono taraf ho aur alag ho = REJECT)
#:   WEAK   → बैच / batch / course / 2027 / medium / science  (sirf bonus, reject nahi)
GRADE_KEY_RE = re.compile(
    r"(?:\b(?:9|10|11|12)\s*(?:th|वीं|वी)\b|\bclass\s*\d{1,2}\b|\b\d{1,2}\s*वीं\b)",
    re.IGNORECASE,
)
STRONG_KEY_RE = re.compile(
    r"(?:"
    r"\bcrash\s*course\b|\bfoundation\b|\btarget\b|\bmanzil\b|मंजिल|"
    r"\bparivartan\b|परिवर्तन|\budaan\b|उड़ान|\bsankalp\b|संकल्प|\bnucleus\b|"
    r"आरंभ|\barambh\b|\bpragati\b|प्रगति|\bjee\b|\bneet\b|\baiims\b|\bcuqet\b|"
    r"\bbiceps\b|\bboard(?:s)?\b|\bpre[\s-]?board(?:s)?\b|\bolympiad\b|"
    r"\bspoken\s*english\b|\benglish\s*(?:batch|course)\b|\bgrammar\b|"
    r"\bcomplete\s*batch\b|\bfull\s*course\b|\brecorded\b|\blive\b"
    r")",
    re.IGNORECASE,
)
WEAK_KEY_RE = re.compile(
    r"(?:\bbatch\b|बैच|\bcourse\b|कोर्स|\bprogram(?:me)?\b|\b20\d{2}\b|"
    r"\bhindi\b|हिंदी|हिन्दी|\benglish\b|अंग्रेजी|\bmedium\b|\bscience\b|विज्ञान|"
    r"\bcommerce\b|वाणिज्य|\barts\b|\bhumanities\b|\bstream\b)",
    re.IGNORECASE,
)
#: Combined (detect ke liye, e.g. caption line course wali hai ya nahi)
COURSE_KEY_RE = re.compile(
    r"(?:%s|%s|%s)" % (GRADE_KEY_RE.pattern, STRONG_KEY_RE.pattern, WEAK_KEY_RE.pattern),
    re.IGNORECASE,
)

#: @username / t.me link / extractor watermark — ALWAYS removed (mandatory).
USERNAME_RE = re.compile(r"(?<![\w])@[\w]{3,32}(?![\w])")
TG_LINK_RE = re.compile(
    r"(?:https?://)?(?:t\.me|telegram\.(?:me|org|dog))[:/][\w/+.\-]+",
    re.IGNORECASE,
)
EXTRACTOR_LINE_RE = re.compile(
    r"^\s*(?:extracted|downloaded|uploaded|shared|powered|posted|credit|"
    r"source|from|channel|group|credit\s*goes)\s*(?:by|to|from)?\s*[:\-–—]?\s*.*$",
    re.IGNORECASE,
)
ERROR_LOG_RE = re.compile(
    r"(?:\berror\b|\btraceback\b|\bexception\b|\bwarning\b|"
    r"['\"]?utf-?8['\"]?\s*codec|can'?t\s+decode|yt-?dlp|ffmpeg|extractor)",
    re.IGNORECASE,
)
YOUTUBE_RE = re.compile(
    r"(?:https?://)?(?:www\.|m\.)?(?:youtube\.com/(?:watch\?v=|embed/|live/|shorts/|v/)"
    r"|youtu\.be/)([A-Za-z0-9_-]{6,})",
    re.IGNORECASE,
)
FILE_EXT_RE = re.compile(
    r"\.(mp4|mkv|webm|mov|avi|flv|m4v|ts|pdf|docx|pptx|zip|rar)\b",
    re.IGNORECASE,
)
#: Decorative watermark unicode (arrows, eagles, tibetan marks, superscripts...)
#: ASCII + Devanagari + common symbols ke alawa sab hata do.
DECOR_RE = re.compile(r"[^\x20-\x7E\u0900-\u097F₹•–—…]+")
PART_RE = re.compile(
    r"(?:\bpart|\blec(?:ture)?|\bclass|\bday|\bep(?:isode)?|\bभाग|\bपार्ट|"
    r"\bखंड)\s*[-–—:#.]*\s*0*(\d{1,3})\b",
    re.IGNORECASE,
)


# ─────────────────────────────────────────────────────────────────────────────
# TEXT CLEANING
# ─────────────────────────────────────────────────────────────────────────────
def strip_usernames(text: str) -> str:
    """@username + t.me links hata deta hai (MANDATORY rule).

    "Extracted By" jaisa plain text reh sakta hai, lekin uske saath ka
    @handle kabhi nahi rehna chahiye.
    """
    if not text:
        return ""
    s = TG_LINK_RE.sub(" ", text)
    s = USERNAME_RE.sub(" ", s)
    return re.sub(r"[ \t]{2,}", " ", s).strip()


def clean_text(text: str, drop_extractor_lines: bool = True) -> str:
    """Caption/title ko display-safe banata hai (watermark, logs, @handle)."""
    if not text:
        return ""
    s = str(text).replace("\r\n", "\n")
    s = strip_usernames(s)

    out_lines: List[str] = []
    for line in s.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        if ERROR_LOG_RE.search(stripped):
            continue
        if drop_extractor_lines and EXTRACTOR_LINE_RE.match(stripped):
            # "Extracted By: xyz" → line drop (aur @handle pehle hi hat chuka)
            continue
        out_lines.append(stripped)

    s = "\n".join(out_lines)
    s = FILE_EXT_RE.sub("", s)
    s = DECOR_RE.sub(" ", s)
    s = re.sub(r"[ \t]{2,}", " ", s)
    return s.strip(" \t-–—:|•\n")


def normalize(text: str) -> str:
    """Compare ke liye canonical form: NFKC + lowercase + sirf word chars."""
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", str(text)).lower()
    s = strip_usernames(s)
    # part/lecture numbers ko canonical banao: "part -2", "part 02" → "part 2"
    s = PART_RE.sub(lambda m: " part %s " % int(m.group(1)), s)
    s = FILE_EXT_RE.sub(" ", s)
    s = re.sub(r"[^0-9a-z\u0900-\u097F]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def tokenize(text: str) -> List[str]:
    return [t for t in normalize(text).split(" ") if len(t) >= 1]


def extract_part_number(text: str) -> Optional[int]:
    if not text:
        return None
    m = PART_RE.search(text)
    if not m:
        m2 = re.search(r"[-–—]\s*0*(\d{1,3})\s*$", text.strip())
        if m2:
            return int(m2.group(1))
        return None
    return int(m.group(1))


def _char_bigrams(s: str) -> set:
    s = s.replace(" ", "")
    if len(s) <= 1:
        return {s} if s else set()
    return {s[i : i + 2] for i in range(len(s) - 1)}


def similarity(a: str, b: str) -> float:
    """0.0 - 1.0 fuzzy similarity (Hindi/Devanagari + English dono ke liye)."""
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if len(na) >= 6 and (na in nb or nb in na):
        return 0.9

    ta, tb = set(tokenize(na)), set(tokenize(nb))
    if not ta or not tb:
        return 0.0
    inter = ta & tb
    jaccard = len(inter) / len(ta | tb)
    containment = len(inter) / min(len(ta), len(tb))

    ba, bb = _char_bigrams(na), _char_bigrams(nb)
    dice = (2 * len(ba & bb) / (len(ba) + len(bb))) if (ba and bb) else 0.0

    return round(jaccard * 0.5 + containment * 0.28 + dice * 0.22, 4)


def _key_set(pattern: "re.Pattern[str]", text: str) -> set:
    if not text:
        return set()
    out = set()
    for m in pattern.finditer(text):
        key = normalize(m.group(0))
        if key:
            out.add(key)
    return out


def course_keys(text: str) -> set:
    """Saare course keys (grade + strong + weak) — diagnostics ke liye."""
    keys = _key_set(GRADE_KEY_RE, text or "")
    keys |= _key_set(STRONG_KEY_RE, text or "")
    keys |= _key_set(WEAK_KEY_RE, text or "")
    for m in re.finditer(r"\b(20\d{2})\b", normalize(text or "")):
        keys.add(m.group(1))
    keys.discard("")
    return keys


def informative_course_keys(text: str) -> set:
    """Sirf 'main' keys (grade + strong) — यही match hona MANDATORY hai."""
    keys = _key_set(GRADE_KEY_RE, text or "")
    keys |= _key_set(STRONG_KEY_RE, text or "")
    keys.discard("")
    return keys


def course_match_score(a: str, b: str) -> float:
    """COURSE NAME match — MANDATORY rule.

    • 12th vs 11th              → 0.0 (REJECT)
    • मंजिल vs परिवर्तन          → 0.0 (REJECT)
    • 12th मंजिल vs 12th मंजिल 27 → ~1.0 (ACCEPT, year/wording farak ignore)
    """
    ia, ib = informative_course_keys(a), informative_course_keys(b)

    if not ia and not ib:
        # Koi main key nahi → sirf text similarity (discount ke saath)
        return round(similarity(a, b) * 0.75, 4)

    if not ia or not ib:
        # Ek taraf main key hai, dusri taraf nahi → weak match
        base = similarity(a, b)
        return round(base * 0.5, 4) if base >= 0.6 else 0.0

    # ── Hard guards (main keys alag = course alag) ─────────────────────────
    ga, gb = _key_set(GRADE_KEY_RE, a or ""), _key_set(GRADE_KEY_RE, b or "")
    if ga and gb and not (ga & gb):
        return 0.0
    sa, sb = _key_set(STRONG_KEY_RE, a or ""), _key_set(STRONG_KEY_RE, b or "")
    if sa and sb and not (sa & sb):
        return 0.0

    shared = ia & ib
    if not shared:
        return 0.0
    union = ia | ib
    base = len(shared) / max(1, len(union))
    return round(min(1.0, base * 0.75 + similarity(a, b) * 0.25), 4)


# ─────────────────────────────────────────────────────────────────────────────
# CAPTION PARSING  (order-independent)
# ─────────────────────────────────────────────────────────────────────────────
def parse_caption(caption: str, file_name: str = "") -> Dict[str, Any]:
    """Caption se title / topic / course / subject / index / link nikalta hai.

    Labels kahin bhi hon (upar-neeche), sab padhe jate hain. Bina label wale
    lines heuristic se classify hote hain.
    """
    raw = (caption or "").replace("\r\n", "\n")
    lines = [ln.strip() for ln in raw.split("\n") if ln.strip()]

    found: Dict[str, str] = {}
    index_num: Optional[int] = None
    youtube = ""
    rest: List[str] = []

    combined_labels = "|".join(LABELS.values())
    label_re = re.compile(r"^(%s)\s*[:\-–—]\s*(.+)$" % combined_labels, re.IGNORECASE)

    for line in lines:
        yt = YOUTUBE_RE.search(line)
        if yt and not youtube:
            youtube = "https://www.youtube.com/watch?v=%s" % yt.group(1)

        m = label_re.match(line)
        if m:
            label_raw, value = m.group(1), m.group(2).strip()
            key = _label_key(label_raw)
            if key == "index":
                digits = re.sub(r"\D", "", value)
                if digits and index_num is None:
                    index_num = int(digits[:6])
                continue
            if key == "link":
                continue  # link upar hi capture ho chuka
            if key and value and key not in found:
                found[key] = value
                continue
            if key and value and key in found:
                found[key] = "%s %s" % (found[key], value)
                continue
        rest.append(line)

    # ── Bina label wale lines ki heuristic classification ───────────────────
    topic_guess = ""
    course_guess = ""
    title_guess = ""
    for line in rest:
        if ERROR_LOG_RE.search(line) or EXTRACTOR_LINE_RE.match(line):
            continue
        has_course_key = bool(COURSE_KEY_RE.search(line))
        has_part = bool(PART_RE.search(line))
        if has_course_key and not course_guess and not has_part:
            course_guess = line
            continue
        if has_course_key and has_part and not title_guess:
            # "12th मंजिल बैच Crash Course - Chemistry Part 1" → title (course bhi)
            title_guess = line
            if not course_guess:
                course_guess = line
            continue
        if not title_guess:
            title_guess = line
        elif not topic_guess:
            topic_guess = line

    title = clean_text(found.get("title") or title_guess or file_name or "")
    if not title and file_name:
        title = clean_text(file_name)

    topic = clean_text(found.get("topic") or topic_guess)
    course = clean_text(found.get("course") or course_guess)
    subject = clean_text(found.get("subject"))

    return {
        "title": title,
        "topic": topic,
        "course": course,
        "subject": subject,
        "index": index_num,
        "youtube_url": youtube,
        "part": extract_part_number(title or topic),
        "raw": raw,
    }


def _label_key(label_raw: str) -> str:
    lab = label_raw.strip().lower()
    for key, pattern in LABELS.items():
        if re.fullmatch(pattern.replace("(?:", "(?:").strip(), lab, re.IGNORECASE):
            return key
    # fallback: pehla word dekh lo
    first = re.sub(r"[^a-z\u0900-\u097F]", "", lab)
    for key in LABELS:
        if first and first.startswith(key[:4]):
            return key
    return ""


# ─────────────────────────────────────────────────────────────────────────────
# CANDIDATE SCORING + DEDUPE
# ─────────────────────────────────────────────────────────────────────────────
def score_candidate(request: Dict[str, Any], candidate: Dict[str, Any]) -> Dict[str, Any]:
    """Website request vs Telegram message candidate → 0-100 score + reason."""
    parsed = candidate.get("parsed") or parse_caption(
        candidate.get("caption", ""), candidate.get("file_name", "")
    )

    req_title = request.get("title") or ""
    req_topic = request.get("topic") or ""
    req_course = request.get("courseName") or request.get("course") or ""

    c_title = parsed.get("title") or candidate.get("file_name") or ""
    c_topic = parsed.get("topic") or ""
    c_course = parsed.get("course") or candidate.get("chat_title") or ""

    title_sim = similarity(req_title, c_title)
    # topic na milne par title hi topic maan lo (folder-wise captions)
    topic_sim = similarity(req_topic, c_topic) if req_topic and c_topic else 0.0
    if req_topic and not c_topic:
        topic_sim = similarity(req_topic, c_title) * 0.6
    course_score = course_match_score(req_course, c_course)

    # ── Hard guards ────────────────────────────────────────────────────────
    req_part = request.get("part") or extract_part_number(req_title)
    c_part = parsed.get("part") or extract_part_number(c_title)
    if req_part and c_part and int(req_part) != int(c_part):
        return {
            "score": 0.0,
            "reason": "part-mismatch (part %s vs part %s)" % (req_part, c_part),
            "titleSim": round(title_sim, 3),
            "topicSim": round(topic_sim, 3),
            "courseScore": round(course_score, 3),
            "parsed": parsed,
        }

    if course_score < COURSE_MIN:
        return {
            "score": 0.0,
            "reason": "course-name mismatch (mandatory rule)",
            "titleSim": round(title_sim, 3),
            "topicSim": round(topic_sim, 3),
            "courseScore": round(course_score, 3),
            "parsed": parsed,
        }

    score = 100.0 * (0.50 * title_sim + 0.18 * topic_sim + 0.32 * course_score)

    # size close ho to bonus (same file hone ka strong signal)
    req_size = int(request.get("fileSize") or 0)
    c_size = int(candidate.get("file_size") or 0)
    if req_size and c_size:
        ratio = min(req_size, c_size) / max(req_size, c_size)
        if ratio > 0.97:
            score += 6.0
        elif ratio < 0.5:
            score -= 8.0

    return {
        "score": round(min(100.0, score), 2),
        "reason": "title=%.2f topic=%.2f course=%.2f" % (title_sim, topic_sim, course_score),
        "titleSim": round(title_sim, 3),
        "topicSim": round(topic_sim, 3),
        "courseScore": round(course_score, 3),
        "parsed": parsed,
    }


def dedupe_candidates(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Same video 2 channel me ho to SIRF best match rakhta hai."""
    best: Dict[str, Dict[str, Any]] = {}
    for cand in candidates:
        parsed = cand.get("parsed") or {}
        key_title = normalize(parsed.get("title") or cand.get("file_name") or "")[:60]
        size_mb = round(int(cand.get("file_size") or 0) / (1024 * 1024))
        dur = round(int(cand.get("duration") or 0) / 15.0)
        key = "%s|%s|%s" % (key_title, size_mb, dur)
        prev = best.get(key)
        if prev is None or cand.get("score", 0) > prev.get("score", 0):
            best[key] = cand
    out = list(best.values())
    out.sort(key=lambda c: (-float(c.get("score") or 0), -int(c.get("file_size") or 0)))
    return out


def pick_best(candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    deduped = dedupe_candidates(candidates)
    for cand in deduped:
        if float(cand.get("score") or 0) >= MATCH_THRESHOLD:
            return cand
    return None


def search_query(title: str, topic: str = "") -> str:
    """Telegram server-side search ke liye chhoti distinctive query."""
    base = clean_text(title)
    base = re.sub(r"\b(?:part|lecture|class)\b\s*[-–—:#.]*\s*\d{1,3}\b", " ", base, flags=re.I)
    words = [w for w in tokenize(base) if len(w) >= 3][:5]
    if not words:
        words = [w for w in tokenize(topic) if len(w) >= 3][:4]
    return " ".join(words)[:90].strip()


# ─────────────────────────────────────────────────────────────────────────────
# DELIVERY CAPTION  (naya, apna caption — English)
# ─────────────────────────────────────────────────────────────────────────────
def build_delivery_caption(
    title: str,
    topic: str = "",
    course: str = "",
    credit_username: str = "krishna84",
    extra: str = "",
) -> str:
    """User rule: 1) Title  2) Topic (folder-wise)  3) Course  4) Extracted By @credit.

    Telegram caption limit = 1024 chars, isliye safe trim bhi hota hai.
    """
    title = clean_text(title)[:180] or "Lecture"
    topic = clean_text(topic)[:160]
    course = clean_text(course)[:160]
    credit = re.sub(r"^@+", "", (credit_username or "krishna84").strip())[:32]

    lines: List[str] = ["📺 %s" % title]
    if topic:
        lines.append("📚 Topic: %s" % topic)
    if course:
        lines.append("🎓 Course: %s" % course)
    if extra:
        lines.append(clean_text(extra)[:120])
    lines.append("")
    lines.append("Extracted By @%s" % credit)

    caption = "\n".join(lines)
    # @username kabhi leak na ho (sirf apna credit handle allowed)
    caption = _keep_only_credit_handle(caption, credit)
    if len(caption) > 1000:
        caption = caption[:1000].rstrip() + "…"
    return caption


def _keep_only_credit_handle(text: str, credit: str) -> str:
    allowed = "@%s" % credit

    def repl(m: "re.Match[str]") -> str:
        return allowed if m.group(0).lower() == allowed.lower() else " "

    out = USERNAME_RE.sub(repl, text)
    return re.sub(r"[ \t]{2,}", " ", out)


def safe_display_name(name: str, fallback: str = "lecture.mp4") -> str:
    base = clean_text(name, drop_extractor_lines=True) or fallback
    base = base.replace("/", "-").replace("\\", "-").strip()[:150]
    if not base:
        base = fallback
    if not re.search(r"\.[A-Za-z0-9]{2,4}$", base):
        base += ".mp4"
    return base


# ─────────────────────────────────────────────────────────────────────────────
# SELF TEST  →  python3 matcher.py
# ─────────────────────────────────────────────────────────────────────────────
def _selftest() -> int:
    failures: List[str] = []

    def check(name: str, cond: bool, extra: Any = "") -> None:
        if not cond:
            failures.append("%s %s" % (name, extra))

    # 1. @username strip
    check(
        "strip @username",
        strip_usernames("Solid State Part 1 @leakedchannel Extracted By: @someone")
        == "Solid State Part 1 Extracted By:",
        strip_usernames("Solid State Part 1 @leakedchannel Extracted By: @someone"),
    )
    check("strip t.me link", strip_usernames("join t.me/xyz now") == "join now")
    check(
        "no @ in delivery caption",
        "@" not in build_delivery_caption(
            "Solid State", "Chemistry", "12th मंजिल", "leakchannel"
        ).replace("@leakchannel", ""),
    )

    # 2. Caption parsing — 3 different field orders
    cap_a = (
        "Index: 42\n"
        "Title: Solid State Part 1\n"
        "Batch: 12th मंजिल बैच 2027\n"
        "Topic: Chemistry - Solid State\n"
        "Extracted By: @somechannel\n"
    )
    cap_b = (
        "Topic: Solid State\n"
        "Course: 12th मंजिल बैच 2027\n"
        "Title: Solid State Part 1\n"
    )
    cap_c = "12th मंजिल बैच 2027\nChemistry - Solid State\nPart 1 (Full Chapter)\n"

    pa, pb, pc = parse_caption(cap_a), parse_caption(cap_b), parse_caption(cap_c)
    check("A title", "solid state" in normalize(pa["title"]), pa["title"])
    check("A index", pa["index"] == 42, pa["index"])
    check("A course", "मंजिल" in pa["course"], pa["course"])
    check("B title", "solid state" in normalize(pb["title"]), pb["title"])
    check("B course", "मंजिल" in pb["course"], pb["course"])
    check("B topic", "solid state" in normalize(pb["topic"]), pb["topic"])
    check("C course", "मंजिल" in pc["course"], pc["course"])
    check("C title", normalize(pc["title"]) != "", pc["title"])
    check("A no @", "@" not in pa["title"] and "@" not in pa["course"])

    # 3. Course match MANDATORY
    check(
        "same course keys",
        course_match_score("12th मंजिल बैच 2027", "12th मंजिल बैच 2026-27") > COURSE_MIN,
    )
    check(
        "different course rejected",
        course_match_score("12th मंजिल बैच 2027", "11th परिवर्तन बैच 2027") == 0.0,
        course_match_score("12th मंजिल बैच 2027", "11th परिवर्तन बैच 2027"),
    )
    check(
        "different class rejected",
        course_match_score("12th Science Crash Course", "10th Science Crash Course") == 0.0,
    )

    # 4. Fuzzy title similarity (Hindi + English, thoda aage-peeche)
    check(
        "fuzzy title",
        similarity("Solid State Part 1 Chemistry", "Chemistry Solid State part 1") > 0.7,
        similarity("Solid State Part 1 Chemistry", "Chemistry Solid State part 1"),
    )
    check("hindi fuzzy", similarity("ठोस अवस्था भाग 2", "ठोस अवस्था Part 2") > 0.5)

    # 5. Part guard — Part 1 kabhi Part 2 se match na ho
    req = {
        "title": "Solid State Part 1",
        "topic": "Chemistry",
        "courseName": "12th मंजिल बैच 2027",
        "fileSize": 400 * 1024 * 1024,
    }
    good = {
        "caption": cap_a,
        "file_name": "Solid State Part 1.mp4",
        "file_size": 401 * 1024 * 1024,
        "chat_title": "12th मंजिल बैच 2027",
    }
    wrong_part = dict(good, caption=cap_a.replace("Part 1", "Part 2"))
    wrong_course = dict(
        good, caption=cap_a.replace("12th मंजिल बैच 2027", "11th परिवर्तन बैच 2027")
    )
    s_good = score_candidate(req, good)
    s_part = score_candidate(req, wrong_part)
    s_course = score_candidate(req, wrong_course)
    check("good match >= threshold", s_good["score"] >= MATCH_THRESHOLD, s_good)
    check("part mismatch rejected", s_part["score"] == 0.0, s_part)
    check("course mismatch rejected", s_course["score"] == 0.0, s_course)

    # 6. Dedupe — 2 channel me same video, best chuna jaye
    dupes = [
        dict(good, score=72.0, chat_id=-1001, message_id=11),
        dict(good, score=91.0, chat_id=-1002, message_id=22),
        dict(good, score=64.0, chat_id=-1003, message_id=33),
    ]
    best = pick_best(dupes)
    check("dedupe picks best", best is not None and best["message_id"] == 22, best)
    check("dedupe keeps 1", len(dedupe_candidates(dupes)) == 1, len(dedupe_candidates(dupes)))

    # 7. Delivery caption format (Title → Topic → Course → credit)
    cap = build_delivery_caption(
        "Solid State Part 1", "Chemistry > Solid State", "12th मंजिल बैच 2027", "krishna84"
    )
    check("caption title first", cap.splitlines()[0].endswith("Solid State Part 1"), cap)
    check("caption topic", "Topic: Chemistry" in cap, cap)
    check("caption course", "Course: 12th मंजिल बैच 2027" in cap, cap)
    check("caption credit", cap.rstrip().endswith("Extracted By @krishna84"), cap)

    # 8. Search query
    q = search_query("Solid State Part 1 Full Chapter", "Chemistry")
    check("search query no part", "part" not in q.lower(), q)

    if failures:
        print("❌ SELF-TEST FAILED (%d):" % len(failures))
        for f in failures:
            print("   - %s" % f)
        return 1

    print("✅ matcher.py self-test passed (all caption/match/dedupe/caption rules OK)")
    return 0


if __name__ == "__main__":
    raise SystemExit(_selftest())
