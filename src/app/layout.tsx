import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppProvider } from "@/context/AppContext";
import AmbientBackground from "@/components/AmbientBackground";
import TelegramPopup from "@/components/TelegramPopup";
import ComingSoonModal from "@/components/ComingSoonModal";
import { SITE_CONFIG } from "@/config/siteConfig";

export const metadata: Metadata = {
  title: `${SITE_CONFIG.appName} | Learn Smarter`,
  description:
    "Study helper Doc - Access all batches, lectures, notes, and study materials in one glowing modern platform.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#050611",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased selection:bg-cyan-400/30 selection:text-cyan-200">
        <AppProvider>
          <AmbientBackground />
          <div className="relative z-10 min-h-screen">{children}</div>
          <TelegramPopup />
          <ComingSoonModal />
        </AppProvider>
      </body>
    </html>
  );
}
