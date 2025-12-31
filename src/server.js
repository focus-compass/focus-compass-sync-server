import "dotenv/config";
import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";
import { Logger } from "@hocuspocus/extension-logger";
import { readFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import formidable from "formidable";
import { BackupService } from "./services/backup.js";

const port = Number(process.env.PORT ?? 8080);
const __dirname = dirname(fileURLToPath(import.meta.url));
const demoFilePath = join(__dirname, "index.html");
const inspectorFilePath = join(__dirname, "inspector.html");

const AUTH_TOKEN = process.env.HOCUSPOCUS_TOKEN ?? "focus-compass-demo-token";
const DB_PATH = process.env.DB_PATH ?? "./data/db.sqlite";
const IMAGES_DIR = process.env.IMAGES_DIR ?? "./data/images";

// Ensure images directory exists
await mkdir(IMAGES_DIR, { recursive: true });

const backupService = new BackupService({
  dbPath: DB_PATH,
  backupDir: "./backups",
  intervalMinutes: Number(process.env.BACKUP_INTERVAL_MINUTES ?? 60),
  retentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 7),
});

// Simple CORS headers
const setCorsHeaders = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
};

// Auth check helper
const checkAuth = (req) => {
  const authHeader = req.headers.authorization;
  return authHeader === `Bearer ${AUTH_TOKEN}`;
};

const server = new Server({
  port,
  timeout: 30000,
  debounce: 2000,
  maxDebounce: 10000,
  extensions: [
    new SQLite({ database: DB_PATH }),
    new Logger(),
  ],

  async onAuthenticate({ token }) {
    if (token !== AUTH_TOKEN) {
      throw new Error("Not authorized");
    }
    return { user: { role: "demo" } };
  },

  async onStoreDocument() {
    await backupService.tryBackup();
  },

  async onRequest({ request, response }) {
    setCorsHeaders(response);

    // Handle preflight
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      throw null;
    }

    const host = request.headers.host ?? "localhost";
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", `http://${host}`).pathname;
    } catch {
      return;
    }

    // --- REST API: Upload Image ---
    if (request.method === "POST" && pathname === "/api/upload") {
      if (!checkAuth(request)) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        throw null;
      }

      const form = formidable({
        uploadDir: IMAGES_DIR,
        keepExtensions: false,
        maxFileSize: 10 * 1024 * 1024,
      });

      try {
        const [fields, files] = await form.parse(request);
        const imageFile = files.file?.[0];
        const imageId = fields.id?.[0];

        if (!imageFile || !imageId) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Missing file or id" }));
          throw null;
        }

        // Security: Sanitize imageId to prevent path traversal
        const sanitizedId = imageId.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!sanitizedId || sanitizedId !== imageId) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Invalid image ID" }));
          throw null;
        }

        const targetPath = join(IMAGES_DIR, sanitizedId);

        // Idempotency: Skip if already exists
        if (existsSync(targetPath)) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ success: true, id: sanitizedId, existed: true }));
          throw null;
        }

        await rename(imageFile.filepath, targetPath);

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: true, id: sanitizedId }));
        throw null;

      } catch (err) {
        if (err === null) throw null;
        console.error("Upload error:", err);
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Upload failed" }));
        throw null;
      }
    }

    // --- REST API: List all images ---
    if (request.method === "GET" && pathname === "/api/images") {
      if (!checkAuth(request)) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        throw null;
      }

      try {
        const { readdir, stat } = await import("node:fs/promises");
        const files = await readdir(IMAGES_DIR);
        const images = await Promise.all(
          files.map(async (name) => {
            const filePath = join(IMAGES_DIR, name);
            const stats = await stat(filePath);
            return { id: name, size: stats.size, modified: stats.mtime };
          })
        );
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ count: images.length, images }));
        throw null;
      } catch (err) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Failed to list images" }));
        throw null;
      }
    }

    // --- REST API: Get Image ---
    if (request.method === "GET" && pathname.startsWith("/api/images/")) {
      if (!checkAuth(request)) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        throw null;
      }

      const imageId = pathname.split("/").pop();

      // Security: Sanitize imageId to prevent path traversal
      const sanitizedId = imageId?.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!sanitizedId || sanitizedId !== imageId) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Invalid image ID" }));
        throw null;
      }

      const filePath = join(IMAGES_DIR, sanitizedId);

      if (!existsSync(filePath)) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Image not found" }));
        throw null;
      }

      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      createReadStream(filePath).pipe(response);
      throw null;
    }

    // --- Static pages ---
    if (request.method !== "GET") return;

    try {
      if (pathname === "/" || pathname === "/index.html") {
        const content = await readFile(demoFilePath, "utf-8");
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(content);
        throw null;
      }

      if (pathname === "/inspector" || pathname === "/inspector.html") {
        const content = await readFile(inspectorFilePath, "utf-8");
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(content);
        throw null;
      }
    } catch (error) {
      if (error === null) throw null;
      console.error(`❌ Error serving ${pathname}:`, error.message);
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end("Internal Server Error");
      throw null;
    }
  },
});

console.log(`🚀 Hocuspocus server starting on port ${port}...`);
console.log(`📁 Database: ${DB_PATH}`);
console.log(`🖼️  Images: ${IMAGES_DIR}`);

try {
  await server.listen();
  console.log(`✅ Server running at http://localhost:${port}`);
} catch (error) {
  console.error("❌ Failed to start server:", error);
  process.exit(1);
}