"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Download, Heart, Home } from "lucide-react";
import { useApp } from "@/context/AppContext";

export default function BottomDock() {
  const pathname = usePathname();
  const { wishlistIds, downloadsList } = useApp();

  const activeDownloadingCount = downloadsList.filter(
    (d) => d.status === "downloading"
  ).length;
  const totalDownloadsCount = downloadsList.length;

  const items = [
    {
      href: "/",
      label: "HOME",
      icon: Home,
      active: pathname === "/",
      activeClasses:
        "border-cyan-400/50 bg-gradient-to-b from-cyan-500/25 to-blue-600/15 text-cyan-200 shadow-glow-cyan",
      dotClass: "bg-cyan-400",
    },
    {
      href: "/wishlist",
      label: "WISHLIST",
      icon: Heart,
      active: pathname === "/wishlist",
      badgeCount: wishlistIds.length,
      badgeBg: "bg-rose-500",
      activeClasses:
        "border-rose-400/50 bg-gradient-to-b from-rose-500/25 to-pink-600/15 text-rose-200 shadow-glow-pink",
      dotClass: "bg-rose-400",
    },
    {
      href: "/downloads",
      label: activeDownloadingCount > 0 ? "SAVING..." : "DOWNLOAD",
      icon: Download,
      active: pathname === "/downloads",
      badgeCount: totalDownloadsCount,
      badgeBg:
        activeDownloadingCount > 0
          ? "bg-cyan-400 text-slate-950 animate-pulse"
          : "bg-purple-500 text-white",
      activeClasses:
        "border-purple-400/50 bg-gradient-to-b from-purple-500/25 to-violet-600/15 text-purple-200 shadow-glow-purple",
      dotClass: "bg-purple-400",
    },
  ];

  return (
    <nav className="fixed bottom-3 left-0 right-0 z-40 mx-auto max-w-lg px-4">
      <div className="grid grid-cols-3 gap-2 rounded-3xl border border-white/12 bg-[#0a0d22]/95 p-2 shadow-[0_12px_40px_rgba(0,0,0,0.75)] backdrop-blur-md">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`relative flex flex-col items-center justify-center rounded-2xl border py-2.5 transition-all duration-200 ${
                item.active
                  ? item.activeClasses
                  : "border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200"
              }`}
            >
              <div className="relative">
                <Icon
                  className={`h-5 w-5 ${
                    item.active && item.label === "WISHLIST"
                      ? "fill-rose-400 text-rose-400"
                      : ""
                  }`}
                />
                {typeof item.badgeCount === "number" && item.badgeCount > 0 && (
                  <span
                    className={`absolute -right-2.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-black shadow ${
                      item.badgeBg || "bg-rose-500 text-white"
                    }`}
                  >
                    {item.badgeCount}
                  </span>
                )}
              </div>
              <span className="mt-1 text-[10px] font-extrabold tracking-widest">
                {item.label}
              </span>
              {item.active && (
                <span
                  className={`absolute -bottom-0.5 h-1.5 w-1.5 rounded-full ${item.dotClass}`}
                />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
