import "server-only";

// ============================================================================
// 100% SERVER-ONLY FIREBASE CONFIGURATION (SUPPORTS REALTIME DB + FIRESTORE)
// Automatically cleans accidental quotes ("...") pasted in Vercel Env Vars UI!
// ============================================================================

export function cleanEnv(raw?: string): string {
  if (!raw) return "";
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function cleanPrivateKey(raw?: string): string {
  if (!raw) return "";
  let s = cleanEnv(raw);

  // If user pasted entire serviceAccountKey.json into FIREBASE_PRIVATE_KEY by mistake, extract private_key!
  if (s.startsWith("{") && s.includes("private_key")) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed.private_key === "string") {
        s = parsed.private_key;
      }
    } catch {
      // ignore
    }
  }

  return s.replace(/\\\\n/g, "\n").replace(/\\n/g, "\n").trim();
}

export interface ParsedFirebaseAdminConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  databaseURL: string;
}

export function getParsedFirebaseAdminConfig(): ParsedFirebaseAdminConfig {
  // Support full JSON env var if user prefers pasting 1 variable
  const fullJsonRaw = cleanEnv(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (fullJsonRaw && fullJsonRaw.startsWith("{")) {
    try {
      const parsed = JSON.parse(fullJsonRaw);
      const pid = cleanEnv(parsed.project_id || process.env.FIREBASE_PROJECT_ID);
      const dbUrl =
        cleanEnv(process.env.FIREBASE_DATABASE_URL) ||
        (pid ? `https://${pid}-default-rtdb.firebaseio.com` : "");
      return {
        projectId: pid,
        clientEmail: cleanEnv(parsed.client_email),
        privateKey: cleanPrivateKey(parsed.private_key),
        databaseURL: dbUrl.replace(/\/$/, ""),
      };
    } catch {
      // fall through
    }
  }

  let projectId = cleanEnv(process.env.FIREBASE_PROJECT_ID);
  let clientEmail = cleanEnv(process.env.FIREBASE_CLIENT_EMAIL);
  const rawPk = process.env.FIREBASE_PRIVATE_KEY || "";

  // Also extract projectId/clientEmail if full JSON was pasted into FIREBASE_PRIVATE_KEY
  const trimmedPk = cleanEnv(rawPk);
  if (trimmedPk.startsWith("{") && trimmedPk.includes("client_email")) {
    try {
      const parsed = JSON.parse(trimmedPk);
      if (!projectId && parsed.project_id) projectId = cleanEnv(parsed.project_id);
      if (!clientEmail && parsed.client_email)
        clientEmail = cleanEnv(parsed.client_email);
    } catch {
      // ignore
    }
  }

  const privateKey = cleanPrivateKey(rawPk);

  // Derive default Realtime Database URL automatically from projectId if FIREBASE_DATABASE_URL is not set!
  const explicitDbUrl = cleanEnv(process.env.FIREBASE_DATABASE_URL);
  const databaseURL = (
    explicitDbUrl ||
    (projectId ? `https://${projectId}-default-rtdb.firebaseio.com` : "")
  ).replace(/\/$/, "");

  return {
    projectId,
    clientEmail,
    privateKey,
    databaseURL,
  };
}

export const firebaseWebServerEnv = {
  apiKey: cleanEnv(process.env.FIREBASE_API_KEY),
  authDomain: cleanEnv(process.env.FIREBASE_AUTH_DOMAIN),
  projectId: cleanEnv(process.env.FIREBASE_PROJECT_ID),
  databaseURL: cleanEnv(process.env.FIREBASE_DATABASE_URL),
  storageBucket: cleanEnv(process.env.FIREBASE_STORAGE_BUCKET),
  messagingSenderId: cleanEnv(process.env.FIREBASE_MESSAGING_SENDER_ID),
  appId: cleanEnv(process.env.FIREBASE_APP_ID),
};

export function getFirebaseMode():
  | "admin-rtdb"
  | "web-rtdb"
  | "web-firestore"
  | "local-fallback" {
  const adminCfg = getParsedFirebaseAdminConfig();
  if (
    adminCfg.projectId &&
    adminCfg.clientEmail &&
    adminCfg.privateKey &&
    adminCfg.privateKey.includes("BEGIN PRIVATE KEY")
  ) {
    return "admin-rtdb";
  }

  if (
    firebaseWebServerEnv.databaseURL &&
    firebaseWebServerEnv.databaseURL.startsWith("https://")
  ) {
    return "web-rtdb";
  }

  if (
    firebaseWebServerEnv.apiKey &&
    firebaseWebServerEnv.apiKey !== "YOUR_FIREBASE_API_KEY" &&
    firebaseWebServerEnv.projectId &&
    firebaseWebServerEnv.projectId !== "your-project-id"
  ) {
    return "web-firestore";
  }

  return "local-fallback";
}
