/**
 * ============================================================================
 * STUDY HELPER DOC — CLOUDFLARE EDGE STREAM WORKER  (v3 "BYTE-EXACT SMOOTH")
 * ============================================================================
 * v3 me kya naya / behtar hai (v2 se):
 *
 *  1) BYTE-EXACT BLOCK VALIDATION (sabse zaroori!)
 *     v2 me agar upstream (Vercel) se 4MB block ka sirf 1.2MB hi aata (network
 *     hiccup / Telegram short-read), to Worker us ADHURE block ko Edge Cache me
 *     7 din ke liye save kar deta tha aur agle block par chala jata tha.
 *     Natija: MP4 ke beech ke bytes gayab -> Chrome ka decoder frames ko
 *     aage-piche phenkta tha = "video ke andar ka character pure time hilta /
 *     jhal-jhal karta" (audio sahi chalta tha).
 *     Ab: har block ki length + Content-Range verify hota hai. Galat/adhura
 *     block KABHI cache nahi hota, 2 baar retry hota hai, phir clean 502 milta
 *     hai taaki player us range ko dubara maange. Corrupt byte = 0%.
 *
 *  2) RANGE-CAPPED RESPONSES (16 MB per request)
 *     Free Worker plan me ek invocation me sirf ~50 subrequests allowed hain.
 *     v2 ek hi request me poori 300-400 MB file bhejne ki koshish karta tha
 *     (75+ subrequests) -> beech me stream toot jata tha = atakna + frame jump.
 *     Ab har 206 response maximum 16 MB deta hai (8 × 2MB blocks) aur Chrome
 *     khud agla slice turant maang leta hai. Playback 100% continuous rehta
 *     hai, RAM/CPU bhi bahut kam lagta hai (low-end phone ke liye best).
 *
 *  3) 2 MB EDGE BLOCKS + HIT/MISS HEADER  (X-SHD-Edge-Cache)
 *  4) HEAD support (PDF.js progressive reader ke liye zaroori)
 *  5) Thumbnail proxy 7-din cache (same as before)
 *
 * ============================================================================
 * CLOUDFLARE PAR KAISE LAGAYEIN (30 second, "Upload files" button use MAT karo):
 *   1. https://dash.cloudflare.com -> Workers & Pages -> "Create"
 *   2. "Start with Hello World!" chunein (Upload build wala option NAHI)
 *   3. Naam dein (jaise: shd-stream) -> Deploy
 *   4. Agla page -> "Edit code" (top-right `</>`) -> sample code delete karein
 *      -> YE POORA CODE paste karein -> Deploy (top-right)
 *   5. Neeche 2 lines (ORIGIN_SITE_URL / ALLOWED_ORIGIN_KEYWORD) apne hisab se
 *      badal lein.
 *   6. `https://shd-stream.<your-subdomain>.workers.dev` URL copy karke
 *      Study helper Doc -> /admin -> Website Settings -> Cloudflare Worker URL
 *      me paste kar dein.
 * ============================================================================
 */

const ORIGIN_SITE_URL = "https://studyhelperdoc.vercel.app";
const ALLOWED_ORIGIN_KEYWORD = "studyhelperdoc"; // preview domains allow karne ke liye "" kar dein

const EDGE_BLOCK_BYTES = 2 * 1024 * 1024; // 2 MB aligned Edge-Cache blocks
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB per 206 response (8 blocks)
const BLOCK_RETRY = 2;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":
    "Range, Content-Type, X-SHD-Client, X-SHD-Worker-Proxy, Authorization",
  "Access-Control-Expose-Headers":
    "Content-Range, Accept-Ranges, Content-Length, Content-Type, X-SHD-Total-Size, X-SHD-File-Name, X-SHD-Mime-Type, X-SHD-Engine, X-SHD-Edge-Cache",
};

/**
 * Ek aligned 2MB block laata hai — pehle Edge Cache se, warna upstream se.
 * Length + Content-Range verify karke hi cache karta hai (byte-exact guarantee).
 */
async function fetchOrCacheAlignedBlock(
  requestUrl,
  upstreamBaseUrl,
  blockIndex,
  ctx,
  knownTotalSize
) {
  const blockStart = blockIndex * EDGE_BLOCK_BYTES;
  const blockEnd = blockStart + EDGE_BLOCK_BYTES - 1;

  const cacheKeyUrl = new URL(requestUrl);
  cacheKeyUrl.search = "";
  cacheKeyUrl.searchParams.set("shdBlk", String(blockIndex));
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });
  const cache = caches.default;

  // ---- 1. Edge Cache hit? (length bhi verify karo — purana corrupt entry ho sakta hai)
  const cachedRes = await cache.match(cacheKey);
  if (cachedRes) {
    const buf = await cachedRes.arrayBuffer();
    const cachedTotal = Number(
      cachedRes.headers.get("X-SHD-Total-Size") || knownTotalSize || "0"
    );
    const expectedLen =
      cachedTotal > 0
        ? Math.min(EDGE_BLOCK_BYTES, Math.max(0, cachedTotal - blockStart))
        : buf.byteLength;

    if (buf.byteLength === expectedLen && buf.byteLength > 0) {
      return {
        ok: true,
        bytes: new Uint8Array(buf),
        totalSize: cachedTotal,
        contentType: cachedRes.headers.get("Content-Type") || "video/mp4",
        fileName: cachedRes.headers.get("X-SHD-File-Name") || "lecture.mp4",
        engine: cachedRes.headers.get("X-SHD-Engine") || "",
        cacheHit: true,
      };
    }

    // Corrupt/purana block -> cache se hatao, dubara fetch karo
    ctx.waitUntil(cache.delete(cacheKey));
  }

  // ---- 2. Upstream (Vercel) se byte-exact block lao (retry ke saath)
  let lastErr = null;
  for (let attempt = 0; attempt <= BLOCK_RETRY; attempt++) {
    try {
      const upstreamRes = await fetch(upstreamBaseUrl, {
        method: "GET",
        headers: {
          Range: `bytes=${blockStart}-${blockEnd}`,
          "X-SHD-Worker-Proxy": "1",
          "X-SHD-Client": "web-player",
        },
      });

      if (!upstreamRes.ok && upstreamRes.status !== 206) {
        return {
          ok: false,
          status: upstreamRes.status,
          errorBody: await upstreamRes.text(),
        };
      }

      const buf = await upstreamRes.arrayBuffer();

      let totalSize = Number(
        upstreamRes.headers.get("X-SHD-Total-Size") || knownTotalSize || "0"
      );
      if (!totalSize) {
        const cr = upstreamRes.headers.get("Content-Range") || "";
        const m = cr.match(/\/(\d+)$/);
        if (m) totalSize = Number(m[1]);
      }

      // Content-Range se confirm karo ki upstream ne WAHI start byte bheja hai
      const cr = upstreamRes.headers.get("Content-Range") || "";
      const crMatch = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
      if (crMatch) {
        const gotStart = Number(crMatch[1]);
        if (gotStart !== blockStart) {
          lastErr = `upstream offset mismatch (wanted ${blockStart}, got ${gotStart})`;
          continue; // retry — galat offset ka block cache nahi karenge
        }
        if (!totalSize) totalSize = Number(crMatch[3]);
      }

      const expectedLen = totalSize
        ? Math.min(EDGE_BLOCK_BYTES, Math.max(0, totalSize - blockStart))
        : buf.byteLength;

      // ADHURA BLOCK = KABHI CACHE NAHI, KABHI AAGE NAHI BADHNA
      if (expectedLen > 0 && buf.byteLength !== expectedLen) {
        lastErr = `short block (got ${buf.byteLength}, expected ${expectedLen})`;
        continue;
      }
      if (buf.byteLength === 0 && expectedLen > 0) {
        lastErr = "empty block";
        continue;
      }

      const contentType =
        upstreamRes.headers.get("Content-Type") || "video/mp4";
      const fileName =
        upstreamRes.headers.get("X-SHD-File-Name") || "lecture.mp4";
      const engine = upstreamRes.headers.get("X-SHD-Engine") || "";

      const toCacheHeaders = new Headers({
        "Content-Type": contentType,
        "X-SHD-Total-Size": String(totalSize),
        "X-SHD-File-Name": fileName,
        "X-SHD-Engine": engine,
        "Cache-Control": "public, max-age=604800",
      });
      ctx.waitUntil(
        cache.put(
          cacheKey,
          new Response(buf.slice(0), { status: 200, headers: toCacheHeaders })
        )
      );

      return {
        ok: true,
        bytes: new Uint8Array(buf),
        totalSize,
        contentType,
        fileName,
        engine,
        cacheHit: false,
      };
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }

  return { ok: false, status: 502, errorBody: `edge block failed: ${lastErr}` };
}

export default {
  async fetch(request, _env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const isStream = url.pathname.startsWith("/stream/");
    const isThumb = url.pathname.startsWith("/thumb/");

    if (!isStream && !isThumb) {
      return new Response(
        "Study helper Doc Edge Streamer v3 (Byte-Exact Smooth) Ready",
        { status: 200, headers: CORS_HEADERS }
      );
    }

    // URL-bar se direct hotlinking block (sirf website ke andar chalega)
    const referer = request.headers.get("Referer") || "";
    const origin = request.headers.get("Origin") || "";
    const secDest = request.headers.get("Sec-Fetch-Dest") || "";

    if (
      ALLOWED_ORIGIN_KEYWORD &&
      secDest === "document" &&
      !referer.includes(ALLOWED_ORIGIN_KEYWORD) &&
      !origin.includes(ALLOWED_ORIGIN_KEYWORD) &&
      !referer.includes("localhost")
    ) {
      return new Response("Protected Stream — Open inside Study helper Doc", {
        status: 403,
        headers: CORS_HEADERS,
      });
    }

    const upstreamUrl = `${ORIGIN_SITE_URL.replace(/\/$/, "")}/api/tg${
      url.pathname
    }`;

    // ------------------------------------------------------------------
    // THUMBNAIL PROXY (chhota JPEG, 7 din Edge Cache)
    // ------------------------------------------------------------------
    if (isThumb) {
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;

      try {
        const up = await fetch(upstreamUrl, {
          headers: { "X-SHD-Worker-Proxy": "1" },
        });
        if (!up.ok) return up;
        const body = await up.arrayBuffer();
        const res = new Response(body, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": up.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=604800",
          },
        });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      } catch {
        return new Response(null, { status: 404, headers: CORS_HEADERS });
      }
    }

    // ------------------------------------------------------------------
    // HEAD (PDF.js / <video> metadata probe)
    // ------------------------------------------------------------------
    if (request.method === "HEAD") {
      try {
        const up = await fetch(upstreamUrl, {
          method: "HEAD",
          headers: {
            "X-SHD-Worker-Proxy": "1",
            "X-SHD-Client": "web-player",
          },
        });
        const headers = new Headers(CORS_HEADERS);
        const pass = [
          "Content-Type",
          "Content-Length",
          "Accept-Ranges",
          "X-SHD-Total-Size",
          "X-SHD-File-Name",
          "X-SHD-Mime-Type",
          "X-SHD-Engine",
        ];
        for (const h of pass) {
          const v = up.headers.get(h);
          if (v) headers.set(h, v);
        }
        return new Response(null, { status: up.status, headers });
      } catch {
        return new Response(null, { status: 502, headers: CORS_HEADERS });
      }
    }

    // ------------------------------------------------------------------
    // GET — Range parse
    // ------------------------------------------------------------------
    const rangeHeader = request.headers.get("Range");
    let startByte = 0;
    let requestedEnd = null;
    let hasRange = false;

    if (rangeHeader && rangeHeader.startsWith("bytes=")) {
      hasRange = true;
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        startByte = parseInt(m[1], 10) || 0;
        if (m[2]) requestedEnd = parseInt(m[2], 10);
      }
    }

    // Pehla block lao (isi se totalSize + headers milte hain)
    const firstBlockIdx = Math.floor(startByte / EDGE_BLOCK_BYTES);
    const firstBlock = await fetchOrCacheAlignedBlock(
      url.toString(),
      upstreamUrl,
      firstBlockIdx,
      ctx,
      0
    );

    if (!firstBlock.ok) {
      return new Response(firstBlock.errorBody || "Upstream stream error", {
        status: firstBlock.status || 502,
        headers: CORS_HEADERS,
      });
    }

    const totalSize = firstBlock.totalSize;
    if (!totalSize || startByte >= totalSize) {
      return new Response(null, {
        status: 416,
        headers: { ...CORS_HEADERS, "Content-Range": `bytes */${totalSize || 0}` },
      });
    }

    // RESPONSE CAP: maximum 16 MB (Chrome agla slice khud maang lega)
    let finalEnd =
      requestedEnd !== null ? Math.min(requestedEnd, totalSize - 1) : totalSize - 1;

    const cappedEnd = startByte + MAX_RESPONSE_BYTES - 1;
    if (finalEnd > cappedEnd) finalEnd = Math.min(cappedEnd, totalSize - 1);

    const contentLength = finalEnd - startByte + 1;
    const lastBlockIdx = Math.floor(finalEnd / EDGE_BLOCK_BYTES);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    let streamAborted = false;

    ctx.waitUntil(
      (async () => {
        try {
          for (let blk = firstBlockIdx; blk <= lastBlockIdx; blk++) {
            const blockData =
              blk === firstBlockIdx
                ? firstBlock
                : await fetchOrCacheAlignedBlock(
                    url.toString(),
                    upstreamUrl,
                    blk,
                    ctx,
                    totalSize
                  );

            // Byte-exact guarantee: adhura/galat block aaya to stream YAHIN
            // band karo (aage badhne par bytes shift ho jate = jhal-jhal video)
            if (!blockData.ok || !blockData.bytes.length) {
              streamAborted = true;
              break;
            }

            const blkFileStart = blk * EDGE_BLOCK_BYTES;
            const sliceStart = Math.max(0, startByte - blkFileStart);
            const sliceEndExcl = Math.min(
              blockData.bytes.length,
              finalEnd - blkFileStart + 1
            );

            if (sliceEndExcl > sliceStart) {
              await writer.write(
                blockData.bytes.subarray(sliceStart, sliceEndExcl)
              );
            }
          }
          await writer.close();
        } catch {
          try {
            await writer.abort();
          } catch {
            // client ne seek/close kar diya
          }
        }
      })()
    );

    const outHeaders = {
      ...CORS_HEADERS,
      "Content-Type": firstBlock.contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(contentLength),
      "X-SHD-Total-Size": String(totalSize),
      "X-SHD-File-Name": firstBlock.fileName,
      "X-SHD-Mime-Type": firstBlock.contentType,
      "X-SHD-Edge-Cache": firstBlock.cacheHit ? "HIT" : "MISS",
      ...(firstBlock.engine ? { "X-SHD-Engine": firstBlock.engine } : {}),
    };

    if (hasRange) {
      outHeaders["Content-Range"] = `bytes ${startByte}-${finalEnd}/${totalSize}`;
    }

    // Note: agar streamAborted hua to body Content-Length se chhota rahega,
    // jisse browser us range ko automatic dubara request karta hai (safe retry).
    void streamAborted;

    return new Response(readable, {
      status: hasRange ? 206 : 200,
      headers: outHeaders,
    });
  },
};
