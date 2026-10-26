import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        obsidian: {
          950: "#050611",
          900: "#090b1e",
          800: "#101432",
          700: "#181e46",
        },
        neon: {
          cyan: "#00f0ff",
          purple: "#8b5cf6",
          pink: "#f43f5e",
          magenta: "#ec4899",
          lime: "#10b981",
          amber: "#f59e0b",
        },
      },
      boxShadow: {
        "glow-cyan": "0 0 20px rgba(0, 240, 255, 0.35), 0 0 40px rgba(0, 240, 255, 0.12)",
        "glow-purple": "0 0 22px rgba(139, 92, 246, 0.4), 0 0 45px rgba(139, 92, 246, 0.15)",
        "glow-pink": "0 0 20px rgba(244, 63, 94, 0.4), 0 0 40px rgba(244, 63, 94, 0.15)",
        "glow-back": "0 0 16px rgba(0, 240, 255, 0.45), inset 0 0 10px rgba(0, 240, 255, 0.18)",
      },
      keyframes: {
        floatSlow: {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)" },
          "50%": { transform: "translate3d(18px, -22px, 0) scale(1.06)" },
        },
        floatReverse: {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)" },
          "50%": { transform: "translate3d(-20px, 18px, 0) scale(1.05)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        pulseGlow: {
          "0%, 100%": { opacity: "0.75" },
          "50%": { opacity: "1" },
        },
      },
      animation: {
        "float-slow": "floatSlow 11s ease-in-out infinite",
        "float-reverse": "floatReverse 13s ease-in-out infinite",
        shimmer: "shimmer 3.5s linear infinite",
        "pulse-glow": "pulseGlow 2.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
