/**
 * Parses ANY YouTube URL, Short URL, Live URL, Embed URL, iframe HTML, or 11-char ID
 * into a clean YouTube Video ID and privacy-enhanced Embed URL.
 */
export function extractYoutubeId(input: string): string | null {
  if (!input) return null;
  let str = input.trim();

  // If user pasted full <iframe ... src="..."> snippet, extract src
  const iframeMatch = str.match(/src=["']([^"']+)["']/i);
  if (iframeMatch?.[1]) {
    str = iframeMatch[1].trim();
  }

  // Direct 11-character YouTube video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
    return str;
  }

  try {
    const url = new URL(str);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }

    if (
      host.includes("youtube.com") ||
      host.includes("youtube-nocookie.com")
    ) {
      const vParam = url.searchParams.get("v");
      if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) return vParam;

      const parts = url.pathname.split("/").filter(Boolean);
      const markerIdx = parts.findIndex((p) =>
        ["embed", "live", "shorts", "v"].includes(p)
      );
      if (markerIdx !== -1 && parts[markerIdx + 1]) {
        const candidate = parts[markerIdx + 1];
        if (/^[a-zA-Z0-9_-]{11}$/.test(candidate)) return candidate;
      }
    }
  } catch {
    // Fallback regex scan
    const regexMatch = str.match(
      /(?:v=|\/embed\/|\/live\/|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/
    );
    if (regexMatch?.[1]) return regexMatch[1];
  }

  return null;
}

export function buildYoutubeEmbedUrl(input: string): {
  youtubeId: string | null;
  embedUrl: string;
  watchUrl: string;
} {
  const ytId = extractYoutubeId(input);
  if (ytId) {
    return {
      youtubeId: ytId,
      embedUrl: `https://www.youtube-nocookie.com/embed/${ytId}?rel=0&modestbranding=1&playsinline=1&enablejsapi=1`,
      watchUrl: `https://www.youtube.com/watch?v=${ytId}`,
    };
  }
  // If user pasted another custom embed URL (non-YouTube iframe/player), preserve safely
  const iframeMatch = input.trim().match(/src=["']([^"']+)["']/i);
  const cleanUrl = iframeMatch?.[1] || input.trim();
  return {
    youtubeId: null,
    embedUrl: cleanUrl,
    watchUrl: cleanUrl,
  };
}
