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

  // Telegram Join Popup Defaults (Overridable via .env TELEGRAM_JOIN_URL or Admin Panel)
  telegramJoinUrl:
    process.env.NEXT_PUBLIC_TELEGRAM_URL ||
    "https://t.me/YOUR_TELEGRAM_CHANNEL_HERE",
  telegramPopupTitle: "Join Telegram for Daily Uploads!",
  telegramPopupSubtitle:
    "Daily new lectures, class notes, aur instant batch updates sabse pehle pane ke liye abhi join karein.",
  telegramAutoCloseSeconds: 5,
};

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (!SITE_CONFIG.apiBaseUrl) return cleanPath;
  return `${SITE_CONFIG.apiBaseUrl.replace(/\/$/, "")}${cleanPath}`;
}
