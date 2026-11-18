import "server-only";
import crypto from "crypto";
import { cleanEnv } from "@/config/firebaseConfig";

// ============================================================================
// 🔐 SERVER SECRETS — ek hi jagah se saari key derivation
// ----------------------------------------------------------------------------
// PEHLE (v4) teeno jagah alag-alag fallback logic tha aur ek silent bug tha:
//
//    const secret = ADMIN_SESSION_SECRET || `${EMAIL}:${PASS}:${PID}` || "dev-key"
//
// beech wala template-literal HAMESHA truthy hota hai (kam se kam "::"),
// isliye teesra fallback kabhi chalta hi nahi tha. Natija: env vars khaali hone
// par vault/stream-token ki master key "::" se banti thi — yaani koi bhi
// `tg_...` media token forge kar sakta tha.
//
// Ab:
//   • Explicit ADMIN_SESSION_SECRET → wahi (recommended)
//   • Warna ADMIN_EMAIL/ADMIN_PASSWORD/FIREBASE_PROJECT_ID se derive
//     (purane vault data ke saath 100% backwards-compatible)
//   • Kuch bhi set nahi:
//       – production → ServerConfigError (loud, clear) — silent weak key NAHI
//       – development → globalThis par ek stable random key (dev-only).
//         Pehle ye per-module random thi, isliye Next dev me login cookie ek
//         route banata tha aur dusra route use verify nahi kar pata tha
//         (= "login ho gaya par sab 401" wala silent loop). Ab stable hai.
// ============================================================================

export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
}

const DEV_MASTER_SECRET = "shd_local_dev_master_key_v3";

declare global {
  // eslint-disable-next-line no-var
  var __shdDevMasterSecret: string | undefined;
  // eslint-disable-next-line no-var
  var __shdSecretWarned: boolean | undefined;
}

function warnOnce(message: string): void {
  if (globalThis.__shdSecretWarned) return;
  globalThis.__shdSecretWarned = true;
  // eslint-disable-next-line no-console
  console.error(`\n🔐 [study-helper-doc] ${message}\n`);
}

/** Env se master secret — production me missing ho to throw. */
export function getServerMasterSecret(): string {
  const explicit = cleanEnv(process.env.ADMIN_SESSION_SECRET);
  if (explicit) return explicit;

  const email = cleanEnv(process.env.ADMIN_EMAIL);
  const pass = cleanEnv(process.env.ADMIN_PASSWORD);
  const projectId = cleanEnv(process.env.FIREBASE_PROJECT_ID);

  // Purane behaviour ke saath byte-identical (existing vault data na toote)
  if (email || pass || projectId) {
    return `${email}:${pass}:${projectId}`;
  }

  if (process.env.NODE_ENV === "production") {
    warnOnce(
      "ADMIN_SESSION_SECRET is not set. Admin login, student sessions and the " +
        "encrypted media vault are DISABLED until you set it (Vercel → " +
        "Settings → Environment Variables). Run `npm run hash-admin` to generate one."
    );
    throw new ServerConfigError(
      "Server configuration error: ADMIN_SESSION_SECRET is not set."
    );
  }

  if (!globalThis.__shdDevMasterSecret) {
    globalThis.__shdDevMasterSecret = crypto.randomBytes(64).toString("hex");
    warnOnce(
      "Development mode: ADMIN_SESSION_SECRET missing, using a temporary in-memory " +
        "secret. Sessions will not survive a restart. Add it to .env.local for stable login."
    );
  }
  return globalThis.__shdDevMasterSecret;
}

/** Wahi secret, par throw ki jagah null (guards/caches ke liye safe). */
export function getServerMasterSecretSafe(): string | null {
  try {
    return getServerMasterSecret();
  } catch {
    return null;
  }
}

export function isServerSecretConfigured(): boolean {
  return (
    Boolean(cleanEnv(process.env.ADMIN_SESSION_SECRET)) ||
    Boolean(
      cleanEnv(process.env.ADMIN_EMAIL) ||
        cleanEnv(process.env.ADMIN_PASSWORD) ||
        cleanEnv(process.env.FIREBASE_PROJECT_ID)
    )
  );
}

/**
 * Cloudflare Worker ⇄ origin ke beech shared secret.
 * Worker isse `X-Worker-Secret` header me bhejta hai taaki koi bahar se
 * `x-shd-worker-proxy: 1` header spoof karke stream guard bypass na kar sake.
 * Admin Panel → Website Settings me copy karne ke liye dikhta hai.
 */
export function getWorkerSharedSecret(): string {
  const secret = getServerMasterSecretSafe();
  if (!secret) return "";
  return crypto
    .createHmac("sha256", secret)
    .update("shd_cloudflare_worker_v1")
    .digest("hex");
}

export function isServerConfigErrorMessage(err: unknown): boolean {
  return err instanceof ServerConfigError;
}
