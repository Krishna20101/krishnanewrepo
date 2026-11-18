import "server-only";
import crypto from "crypto";
import type { NextRequest } from "next/server";
import { cleanEnv } from "@/config/firebaseConfig";
import { getWorkerSharedSecret } from "@/lib/serverSecrets";

// ============================================================================
// 🛡 MEDIA STREAM GUARDS + CORS  (v5 hardening)
// ----------------------------------------------------------------------------
// PEHLE (v4) `/api/tg/stream/[token]` ka hotlink-guard aisa tha:
//
//     if (range header hai)          → allow
//     if (x-shd-client: web-player)  → allow
//     if (x-shd-worker-proxy: 1)     → allow
//
// teeno headers client-side se set ho sakte hain, yaani guard sirf decoration
// tha (koi bhi `curl -H "Range: bytes=0-"` se direct stream nikal sakta tha).
// Aur next.config me `Access-Control-Allow-Origin: *` + `Allow-Credentials:
// true` ek saath tha — jo CORS spec ke hisaab se invalid combination hai.
//
// AB:
//   1) Cloudflare Worker proxy → shared secret (`X-Worker-Secret`) se verify
//      hota hai (admin panel se copy karke worker.js me paste karna hota hai).
//      Purane workers na toote isliye enforcement ek SETTING hai
//      (`requireWorkerSecret`), default off → update karke ON kar dein.
//   2) Logged-in student/admin session cookie → allow
//   3) Same-origin browser request (Sec-Fetch-Site: same-origin) → allow
//      (`<video>`, pdf.js range fetch, offline-vault download sab isi se aate hain)
//   4) Baaki sab → DENY (URL-bar hotlinking / cross-site embedding block)
//
//   CORS: wildcard ki jagah sirf allowlisted origin reflect hota hai
//   (apna domain, Cloudflare worker, *.vercel.app preview, localhost).
// ============================================================================

export interface StreamGuardOptions {
  /** Admin setting: worker proxy par shared secret zaroori hai ya nahi */
  requireWorkerSecret?: boolean;
  /** Allowed CORS origins (site domain, worker URL, extra env list) */
  allowedOrigins?: string[];
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** `x-shd-worker-proxy: 1` + (optional) valid `X-Worker-Secret`. */
export function isTrustedWorkerProxy(
  req: NextRequest,
  options: StreamGuardOptions = {}
): boolean {
  if (req.headers.get("x-shd-worker-proxy") !== "1") return false;

  const expected = getWorkerSharedSecret();
  const provided =
    req.headers.get("x-worker-secret") || req.headers.get("x-shd-worker-secret") || "";

  if (options.requireWorkerSecret) {
    return Boolean(expected) && timingSafeEqualStr(provided, expected);
  }

  // Backwards-compatible: secret bheja gaya ho to verify zaroor karo
  if (provided) return timingSafeEqualStr(provided, expected);
  return true;
}

/**
 * Media stream request allowed hai ya nahi (DEFAULT-DENY).
 * Note: ye sirf "hotlink/URL-bar" protection hai — asli capability encrypted
 * `tg_...` token hi hai (jo login ke baad hi milta hai).
 */
export function isAllowedStreamRequest(
  req: NextRequest,
  ctx: { hasSession: boolean; options?: StreamGuardOptions }
): boolean {
  const options = ctx.options || {};

  // 1) Cloudflare Worker (edge cache) proxy
  if (isTrustedWorkerProxy(req, options)) return true;

  // 2) Logged-in student/admin (same-origin cookie ya Bearer token)
  if (ctx.hasSession) return true;

  // 3) Browser ka same-origin media/fetch request
  const site = (req.headers.get("sec-fetch-site") || "").toLowerCase();
  const dest = (req.headers.get("sec-fetch-dest") || "").toLowerCase();
  const mode = (req.headers.get("sec-fetch-mode") || "").toLowerCase();

  if (site === "same-origin") {
    // <video>/<audio>/pdf.js fetch/offline-vault download
    return ["video", "audio", "empty", "image", "no-cors"].includes(dest) || mode === "cors";
  }

  // 4) Baaki sab deny:
  //    • sec-fetch-site: none      → URL bar / bookmark / direct curl
  //    • sec-fetch-site: cross-site→ kisi dusri website se embed
  //    • koi header hi nahi        → non-browser client (curl/script)
  return false;
}

/** CORS allowlist: apna origin + worker + vercel previews + localhost + env list. */
export function resolveAllowedOrigin(
  req: NextRequest,
  extraAllowed: string[] = []
): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null; // same-origin request → CORS header ki zaroorat nahi

  let host = "";
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  const ownHost = (req.headers.get("host") || "").toLowerCase().split(":")[0];
  if (host === ownHost) return origin;

  if (host.endsWith(".vercel.app") || host.endsWith(".e2b.app")) return origin;
  if (host === "localhost" || host === "127.0.0.1") return origin;

  const configured = [
    ...extraAllowed.filter(Boolean),
    ...cleanEnv(process.env.CORS_ALLOWED_ORIGINS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];

  for (const entry of configured) {
    const candidate = entry.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!candidate) continue;
    if (candidate.startsWith("*.")) {
      if (host.endsWith(candidate.slice(1))) return origin;
    } else if (host === candidate || host === candidate.split(":")[0]) {
      return origin;
    }
  }

  return null;
}

/**
 * Media routes ke liye CORS headers.
 * 🔒 `Access-Control-Allow-Origin: *` + credentials ka invalid combo hata diya —
 * ab sirf allowlisted origin reflect hota hai (warna header hi nahi jata).
 */
export function streamCorsHeaders(
  req: NextRequest,
  extraAllowed: string[] = []
): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers":
      "Range, Content-Type, X-SHD-Client, X-SHD-Worker-Proxy, X-Worker-Secret",
    "Access-Control-Expose-Headers":
      "Content-Range, Accept-Ranges, Content-Length, Content-Type, X-SHD-Total-Size, X-SHD-File-Name, X-SHD-Mime-Type, X-SHD-Engine, X-SHD-Edge-Cache",
    "Access-Control-Max-Age": "86400",
  };

  const allowed = resolveAllowedOrigin(req, extraAllowed);
  if (allowed) {
    headers["Access-Control-Allow-Origin"] = allowed;
    headers["Vary"] = "Origin";
    // Sirf allowlisted origin ke liye credentials (cookie) allow karein
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}
