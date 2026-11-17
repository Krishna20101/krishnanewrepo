// ============================================================================
// STUDY HELPER DOC - PUBLIC UI DEFAULTS
// Sensitive secrets (Admin ID/Pass & Firebase Keys) yahan NAHI hain — wo 100%
// secure '.env' file me server-side par rakhe gaye hain!
// ============================================================================

export const SITE_CONFIG = {
  appName: "Study helper Doc",
  appTagline: "ALL BATCHES UNLOCK FREE",

  // Vercel Deployment Domain
  appDomain:
    process.env.NEXT_PUBLIC_APP_DOMAIN || "https://studyhelperdoc.vercel.app",

  // Same-origin '/api' by default
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || "",

  // Fallback Placeholder Image URL (Overridable via .env DEFAULT_IMAGE_URL or Admin Panel)
  defaultImageUrl:
    process.env.NEXT_PUBLIC_DEFAULT_IMAGE_URL ||
    "https://placehold.co/800x450/0d1230/00f0ff?text=Study+helper+Doc",

  // App Logo URL (Overridable via .env APP_LOGO_URL or Admin Panel)
  appLogoUrl:
    process.env.NEXT_PUBLIC_APP_LOGO_URL ||
    "https://placehold.co/200x200/0d1230/00f0ff?text=SHD",

  /**
   * Telegram channel link (Overridable via .env TELEGRAM_JOIN_URL or Admin Panel).
   * 🔧 FIX (v5): pehle yahan placeholder `https://t.me/YOUR_TELEGRAM_CHANNEL_HERE`
   * tha — wo dead link user tak chala jata tha. Ab default KHALI hai; UI
   * (`isTelegramJoinUrlConfigured`) empty/placeholder hone par CTA hi nahi
   * dikhata, aur popup bhi nahi khulta jab tak admin real link set na kare.
   */
  telegramJoinUrl: process.env.NEXT_PUBLIC_TELEGRAM_URL || "",
  telegramPopupTitle: "Join Telegram for Daily Uploads!",
  telegramPopupSubtitle:
    "Join now to get daily new lectures, class notes and instant batch updates first.",
  telegramAutoCloseSeconds: 5,
};

/**
 * Telegram join link configured hai ya nahi — placeholder/dead links ko
 * "configured" nahi maante.
 */
export function isTelegramJoinUrlConfigured(url?: string | null): boolean {
  const value = String(url || "").trim();
  if (!value) return false;
  if (!/^https?:\/\//i.test(value)) return false;
  if (/YOUR_TELEGRAM_CHANNEL_HERE|example\.com|placeholder/i.test(value)) return false;
  return true;
}

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (!SITE_CONFIG.apiBaseUrl) return cleanPath;
  return `${SITE_CONFIG.apiBaseUrl.replace(/\/$/, "")}${cleanPath}`;
}
