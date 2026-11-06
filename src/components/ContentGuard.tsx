"use client";

import { useEffect } from "react";

/**
 * 🛡️ CONTENT GUARD  (client deterrent layer)
 * ----------------------------------------------------------------------------
 * Kya karta hai:
 *  • Page par right-click / long-press context menu block
 *  • Text select + copy / cut ka default roka jata hai (password fields chhod kar)
 *  • DevTools shortcuts (F12, Ctrl/Cmd+Shift+I/J/C, Ctrl+U "view source",
 *    Ctrl+S "save page") ko intercept
 *  • Drag-and-drop se image/video nikalna band
 *  • Print dialog (Ctrl+P) block
 *
 * ⚠️ Honest note: koi bhi client-side guard 100% unbreakable nahi hota —
 *    jo user DevTools kholna jaanta hai wo ise bypass kar sakta hai. Asli
 *    protection server-side hai (signed sessions, expiring media tokens,
 *    Telegram-only delivery). Ye layer casual copying ko rok deti hai.
 */
export default function ContentGuard() {
  useEffect(() => {
    // Agar admin ne explicitly allow kiya ho to band
    if (process.env.NEXT_PUBLIC_DISABLE_CONTENT_GUARD === "1") return;

    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable === true
      );
    };

    const onContextMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      // inputs me right-click chalta rahe (paste/copy ke liye)
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      e.preventDefault();
    };

    const onCopyCut = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
    };

    const onDragStart = (e: DragEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(IMG|VIDEO|CANVAS)$/.test(el.tagName)) {
        e.preventDefault();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;

      // DevTools + source + save + print
      const blockedCombo =
        (mod && e.shiftKey && ["i", "j", "c"].includes(key)) ||
        (mod && ["u", "s", "p"].includes(key)) ||
        key === "f12";

      if (blockedCombo) {
        // print dialog browser-level hai, isko rok sakte hain
        if (key === "p" && mod) e.preventDefault();
        else if (key === "s" && mod) e.preventDefault();
        else if (key === "u" && mod) e.preventDefault();
        else if (key === "f12") e.preventDefault();
        else if (mod && e.shiftKey) e.preventDefault();
      }
    };

    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("copy", onCopyCut);
    document.addEventListener("cut", onCopyCut);
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("copy", onCopyCut);
      document.removeEventListener("cut", onCopyCut);
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return null;
}
