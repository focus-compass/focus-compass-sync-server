import "dotenv/config";

import { SQLite } from "@hocuspocus/extension-sqlite";
import { Server } from "@hocuspocus/server";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAuth, normalizeAuthToken, safeEqual } from "./lib/auth.js";
import { readBoolEnv, readNumberEnv } from "./lib/env.js";
import { readJsonOrNull } from "./lib/fs.js";
import {
  createCorsPolicy,
  parseRequestUrl,
  setCorsHeaders,
  setSecurityHeaders,
} from "./lib/http.js";
import { json, noContent } from "./lib/responses.js";
import { handleAdminRequest } from "./routes/admin.js";
import { handleAuthRequest } from "./routes/auth.js";
import { handleImagesRequest } from "./routes/images.js";
import { handleMcpRequest } from "./routes/mcp.js";
import { handleMcpAdminRequest } from "./routes/mcpAdmin.js";
import { handleStaticRequest } from "./routes/static.js";
import { handleWorkspaceRequest } from "./routes/workspace.js";
import { BackupService } from "./services/backup.js";

const port = readNumberEnv("PORT", 8080);
const __dirname = dirname(fileURLToPath(import.meta.url));
const indexFilePath = join(__dirname, "index.html");
const mcpSkillFilePath = join(__dirname, "focus-compass-skill.md");

const packageJsonPath = join(__dirname, "..", "package.json");
const packageJson = await readJsonOrNull(packageJsonPath);
const packageVersion =
  packageJson && typeof packageJson.version === "string" ? packageJson.version.trim() : "";
const appVersion = (String(process.env.APP_VERSION ?? "").trim() || packageVersion).trim();

const updateRepo =
  String(process.env.UPDATE_REPO ?? process.env.GITHUB_UPDATE_REPO ?? "").trim() ||
  "focus-compass/focus-compass-sync-server";

const DB_PATH = process.env.DB_PATH ?? "./data/db.sqlite";
const IMAGES_DIR = process.env.IMAGES_DIR ?? "./data/images";
const UPLOAD_TMP_DIR = join(IMAGES_DIR, ".tmp");

const AUTH_FILE_PATH =
  process.env.AUTH_FILE_PATH ?? join(dirname(DB_PATH), "auth.json");

const MCP_AUTH_FILE_PATH =
  process.env.MCP_AUTH_FILE_PATH ?? join(dirname(DB_PATH), "mcp-auth.json");

const envTokenRaw = normalizeAuthToken(process.env.HOCUSPOCUS_TOKEN);
const envToken = envTokenRaw && envTokenRaw.trim() ? envTokenRaw.trim() : "";
const envManaged = Boolean(envToken);

const persistedAuth = await readJsonOrNull(AUTH_FILE_PATH);
const persistedToken =
  persistedAuth && typeof persistedAuth.token === "string" ? persistedAuth.token.trim() : "";

let authToken = envToken || persistedToken || "";


const envMcpTokenRaw = normalizeAuthToken(process.env.MCP_TOKEN);
const envMcpToken = envMcpTokenRaw && envMcpTokenRaw.trim() ? envMcpTokenRaw.trim() : "";
const mcpEnvManaged = Boolean(envMcpToken);

const persistedMcpAuth = await readJsonOrNull(MCP_AUTH_FILE_PATH);
const persistedMcpToken =
  persistedMcpAuth && typeof persistedMcpAuth.token === "string"
    ? persistedMcpAuth.token.trim()
    : "";

let mcpToken = envMcpToken || persistedMcpToken || "";


const BACKUP_DIR = process.env.BACKUP_DIR ?? join(dirname(DB_PATH), "backups");
const BACKUP_INTERVAL_MINUTES = readNumberEnv("BACKUP_INTERVAL_MINUTES", 60);
const BACKUP_RETENTION_DAYS = readNumberEnv("BACKUP_RETENTION_DAYS", 7);

const MAX_UPLOAD_BYTES = readNumberEnv("MAX_UPLOAD_BYTES", 10 * 1024 * 1024);
const MAX_DOC_DECODE_BYTES = readNumberEnv("MAX_DOC_DECODE_BYTES", 8 * 1024 * 1024);

const YJS_GC = readBoolEnv("YJS_GC", false);

const getAuthToken = () => authToken;
const setAuthToken = (token) => {
  authToken = typeof token === "string" ? token.trim() : "";
};

const getMcpToken = () => mcpToken;
const setMcpToken = (token) => {
  mcpToken = typeof token === "string" ? token.trim() : "";
};

const isAuthed = (req) => {
  const expected = getAuthToken();
  if (!expected) return false;
  return checkAuth(req, expected);
};

const isMcpAuthed = (req) => {
  const expected = getMcpToken();
  if (!expected) return false;
  return checkAuth(req, expected);
};

const corsPolicy = createCorsPolicy(process.env.CORS_ALLOW_ORIGINS ?? "*");

// Ensure data directories exist
await mkdir(dirname(DB_PATH), { recursive: true });
await mkdir(IMAGES_DIR, { recursive: true });
await mkdir(UPLOAD_TMP_DIR, { recursive: true });

const backupService = new BackupService({
  dbPath: DB_PATH,
  backupDir: BACKUP_DIR,
  intervalMinutes: BACKUP_INTERVAL_MINUTES,
  retentionDays: BACKUP_RETENTION_DAYS,
});

const server = new Server({
  port,
  timeout: 30000,
  debounce: 2000,
  maxDebounce: 10000,
  // By default, GC is disabled to preserve full CRDT state.
  // Set YJS_GC=true to trade disk size for GC compaction.
  yDocOptions: {
    gc: YJS_GC,
  },
  extensions: [new SQLite({ database: DB_PATH })],

  async onAuthenticate({ token, request, requestParameters }) {
    const expected = getAuthToken();
    if (!expected) {
      throw new Error("Not authorized");
    }

    let candidate = normalizeAuthToken(token);

    if (!candidate && requestParameters && typeof requestParameters.get === "function") {
      candidate = normalizeAuthToken(requestParameters.get("token"));
    }

    if (!candidate && request) {
      const url = parseRequestUrl(request);
      const firstSeg = url?.pathname
        ? url.pathname
          .split("/")
          .filter(Boolean)
          .slice(0, 1)[0]
        : null;
      if (firstSeg) candidate = firstSeg;
    }

    if (!candidate || !safeEqual(candidate, expected)) {
      throw new Error("Not authorized");
    }

    return { user: { role: "demo" } };
  },

  async onStoreDocument() {
    await backupService.tryBackup();
  },

  async onRequest({ request, response }) {
    try {
      setSecurityHeaders(response);
      setCorsHeaders(request, response, corsPolicy);

      // Handle preflight
      if (request.method === "OPTIONS") {
        noContent(response);
      }

      const url = parseRequestUrl(request);
      if (!url) return;
      const pathname = url.pathname;

      // --- Healthcheck ---
      if (request.method === "GET" && pathname === "/health") {
        json(response, 200, { ok: true });
      }

      await handleAuthRequest({
        request,
        response,
        pathname,
        authFilePath: AUTH_FILE_PATH,
        getToken: getAuthToken,
        setToken: setAuthToken,
        checkAuth: isAuthed,
        envManaged,
        appVersion,
        updateRepo,
      });

      await handleMcpAdminRequest({
        request,
        response,
        pathname,
        mcpAuthFilePath: MCP_AUTH_FILE_PATH,
        getMcpToken,
        setMcpToken,
        getMasterToken: getAuthToken,
        checkMasterAuth: isAuthed,
        envManaged: mcpEnvManaged,
      });

      await handleImagesRequest({
        request,
        response,
        pathname,
        imagesDir: IMAGES_DIR,
        uploadTmpDir: UPLOAD_TMP_DIR,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        checkAuth: isAuthed,
      });

      await handleAdminRequest({
        request,
        response,
        url,
        pathname,
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
        checkAuth: isAuthed,
        maxDocDecodeBytes: MAX_DOC_DECODE_BYTES,
      });

      await handleWorkspaceRequest({
        request,
        response,
        url,
        pathname,
        dbPath: DB_PATH,
        checkAuth: isAuthed,
        maxDocDecodeBytes: MAX_DOC_DECODE_BYTES,
      });

      await handleMcpRequest({
        request,
        response,
        pathname,
        dbPath: DB_PATH,
        appVersion,
        maxDocDecodeBytes: MAX_DOC_DECODE_BYTES,
        getToken: getMcpToken,
        checkAuth: isMcpAuthed,
      });

      await handleStaticRequest({
        request,
        response,
        pathname,
        url,
        indexFilePath,
        mcpSkillFilePath,
      });
    } catch (err) {
      if (err === null) throw null;
      console.error("Request handler error:", err);
      if (!response.headersSent) {
        json(response, 500, { error: "Internal Server Error" });
      }
      if (!response.writableEnded) {
        try {
          response.end();
        } catch {
          // Ignore double-end errors
        }
      }
      throw null;
    }
  },
});

console.log(`Hocuspocus server starting on port ${port}...`);

if (envManaged) {
  console.log("Auth: env token is set");
} else if (getAuthToken()) {
  console.log("Auth: token loaded from disk");
} else {
  console.log(`Auth: not initialized (open http://localhost:${port}/)`);
}

try {
  const shutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}, shutting down...`);
    try {
      if (typeof server.destroy === "function") {
        await server.destroy();
      } else if (typeof server.close === "function") {
        await server.close();
      }
    } catch (error) {
      console.error("❌ Error during shutdown:", error);
    }
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await server.listen();
  console.log(`Server running at http://localhost:${port}`);
} catch (error) {
  console.error("❌ Failed to start server:", error);
  process.exit(1);
}
