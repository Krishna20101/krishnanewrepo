"use client";

import React from "react";

/**
 * Ultra-Lightweight Zero-Blur Mobile-Safe GenZ Neon Background!
 * Uses pure static radial-gradients (0px CSS filter blur, 0 continuous GPU repaints on mobile)
 * so even ₹6,000 / 2GB RAM phones NEVER turn black or lag!
 */
export default function AmbientBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-[#050611]"
      style={{
        backgroundImage: `
          radial-gradient(circle at 12% 10%, rgba(0, 240, 255, 0.14) 0%, transparent 42%),
          radial-gradient(circle at 88% 36%, rgba(139, 92, 246, 0.15) 0%, transparent 45%),
          radial-gradient(circle at 30% 90%, rgba(244, 63, 94, 0.11) 0%, transparent 42%)
        `,
      }}
    >
      <div className="absolute inset-0 bg-cyber-grid opacity-70" />
    </div>
  );
}
