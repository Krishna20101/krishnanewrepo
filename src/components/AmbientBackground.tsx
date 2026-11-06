"use client";

import React from "react";

/**
 * Naya ambient canvas — purana "cyber grid + neon radial glow" gaya.
 * Ab: deep ink-navy base + do soft warm/cool radial wash + halka paper grain.
 * 0 filter blur, 0 animation → ₹6000 phone par bhi battery/GPU flat.
 */
export default function AmbientBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0">
      <div className="absolute inset-0 bg-canvas" />
      <div className="absolute inset-0 bg-grain opacity-80" />
      {/* top-right ember wash */}
      <div
        className="absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-40"
        style={{
          background:
            "radial-gradient(circle, rgba(222,122,67,0.35) 0%, transparent 70%)",
        }}
      />
      {/* bottom-left sage wash */}
      <div
        className="absolute -bottom-28 -left-24 h-80 w-80 rounded-full opacity-30"
        style={{
          background:
            "radial-gradient(circle, rgba(124,186,164,0.3) 0%, transparent 72%)",
        }}
      />
    </div>
  );
}
