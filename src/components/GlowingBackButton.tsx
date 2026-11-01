"use client";

import React from "react";
import { ChevronLeft } from "lucide-react";
import { useRouter } from "next/navigation";

interface GlowingBackButtonProps {
  onClick?: () => void;
  fallbackHref?: string;
  label?: string;
}

/**
 * Signature Glowing "< BACK" Button across every inner screen so users
 * can always step back cleanly with electric visual feedback.
 */
export default function GlowingBackButton({
  onClick,
  fallbackHref = "/",
  label = "BACK",
}: GlowingBackButtonProps) {
  const router = useRouter();

  const handleBack = () => {
    if (onClick) {
      onClick();
      return;
    }
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push(fallbackHref);
    }
  };

  return (
    <button
      type="button"
      onClick={handleBack}
      className="group relative inline-flex items-center gap-1 rounded-xl border border-cyan-400/50 bg-cyan-500/10 px-3.5 py-2 text-xs font-extrabold tracking-wider text-cyan-200 shadow-glow-back transition-all duration-200 hover:scale-[1.03] hover:border-cyan-300 hover:bg-cyan-400/20 hover:text-white active:scale-95"
    >
      <ChevronLeft className="h-4 w-4 text-cyan-300 transition-transform duration-200 group-hover:-translate-x-0.5" />
      <span>{label}</span>
    </button>
  );
}
