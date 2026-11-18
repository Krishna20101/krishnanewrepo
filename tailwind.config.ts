import type { Config } from "tailwindcss";

// ============================================================================
// 🎨 STUDY HELPER — DARK INDIGO + COPPER THEME (v4 "Slate & Ember")
// ----------------------------------------------------------------------------
// Purana theme: neon cyan / purple / rose glow (dark cyberpunk).
// Naya theme: deep ink-navy canvas + warm copper/ember accent + soft sand text.
// Koi neon glow nahi, flat layered surfaces, subtle borders — ekdum alag look.
// ============================================================================

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Deep ink navy canvas
        ink: {
          950: "#08090f",
          900: "#0c0e17",
          850: "#11131e",
          800: "#181b28",
          700: "#222737",
        },
        // Warm copper / ember accent (primary brand)
        ember: {
          300: "#f9c8a0",
          400: "#f0a06a",
          500: "#de7a43",
          600: "#bc5f2d",
          700: "#8e4520",
        },
        // Secondary cool accent (calm teal, used sparingly)
        sage: {
          300: "#a7d6c5",
          400: "#7cbaa4",
          500: "#55917c",
        },
        // Soft sand text
        sand: {
          100: "#f5f1e8",
          200: "#e2dcd0",
          300: "#c3bcae",
          400: "#96907f",
          500: "#6f6959",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
      },
      borderRadius: {
        // Asymmetric "notebook" corners — koi pill/neon round nahi
        card: "1.35rem",
        tag: "0.5rem",
      },
      boxShadow: {
        // Soft paper-depth (no neon)
        lift: "0 18px 42px -22px rgba(4, 6, 14, 0.9)",
        "lift-sm": "0 8px 22px -14px rgba(4, 6, 14, 0.85)",
        ember: "0 0 0 1px rgba(222, 122, 67, 0.35), 0 12px 26px -18px rgba(222, 122, 67, 0.55)",
      },
      keyframes: {
        riseIn: {
          "0%": { opacity: "0", transform: "translateY(14px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        sweep: {
          "0%": { transform: "translateX(-120%)" },
          "100%": { transform: "translateX(220%)" },
        },
        breathe: {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        tiltIn: {
          "0%": { opacity: "0", transform: "rotate(-1.2deg) translateY(18px)" },
          "100%": { opacity: "1", transform: "rotate(0deg) translateY(0)" },
        },
      },
      animation: {
        "rise-in": "riseIn 0.42s cubic-bezier(0.22, 0.9, 0.3, 1) both",
        sweep: "sweep 2.6s ease-in-out infinite",
        breathe: "breathe 3.4s ease-in-out infinite",
        "tilt-in": "tiltIn 0.5s cubic-bezier(0.22, 0.9, 0.3, 1) both",
      },
    },
  },
  plugins: [],
};

export default config;
