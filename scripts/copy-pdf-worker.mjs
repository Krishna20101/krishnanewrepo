// pdf.js worker ko public/ me copy karta hai taaki PDF viewer bina internet/CDN
// ke chale (Vercel par static file serve hoti hai: /pdf.worker.min.js)
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.js");
const destDir = join(root, "public");
const dest = join(destDir, "pdf.worker.min.js");

try {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  if (existsSync(src)) {
    copyFileSync(src, dest);
    console.log("✅ pdf.worker.min.js copied to public/");
  } else {
    console.log("ℹ️  pdfjs-dist not installed yet — skipping worker copy.");
  }
} catch (err) {
  console.log("⚠️  pdf worker copy skipped:", err.message);
}
