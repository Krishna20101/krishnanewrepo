import type { Metadata, Viewport } from "next";
import "./globals.css";
// Typography: koi external font request nahi (0 network, 0 layout shift).
// Display = system serif stack, Body = clean geometric sans stack —
// defined in globals.css as --font-display / --font-body.
import { AppProvider } from "@/context/AppContext";
import AmbientBackground from "@/components/AmbientBackground";
import TelegramPopup from "@/components/TelegramPopup";
import ComingSoonModal from "@/components/ComingSoonModal";
import ContentGuard from "@/components/ContentGuard";
import { SITE_CONFIG } from "@/config/siteConfig";

export const metadata: Metadata = {
  title: `${SITE_CONFIG.appName} | Learn Smarter`,
  description:
    "Study helper Doc - Access all batches, lectures, notes, and study materials in one place.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#08090f",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <AppProvider>
          <ContentGuard />
          <AmbientBackground />
          <div className="relative z-10 min-h-screen">{children}</div>
          <TelegramPopup />
          <ComingSoonModal />
        </AppProvider>
      </body>
    </html>
  );
}
