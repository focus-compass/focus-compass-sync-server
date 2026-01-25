import "dotenv/config";
import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";
import { Logger } from "@hocuspocus/extension-logger";
import { readFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import formidable from "formidable";
import { BackupService } from "./services/backup.js";

const port = Number(process.env.PORT ?? 8080);
const __dirname = dirname(fileURLToPath(import.meta.url));
const demoFilePath = join(__dirname, "index.html");
const inspectorFilePath = join(__dirname, "inspector.html");
const adminFilePath = join(__dirname, "admin.html");

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

// Extract content from Yjs shared types (handles AbstractType)
const extractYjsContent = (sharedType) => {
  if (!sharedType) return null;

  // Try standard toJSON first (works for properly typed instances)
  try {
    const json = sharedType.toJSON();
    if (json !== undefined && json !== null && Object.keys(json).length > 0) {
      return json;
    }
  } catch {
    // Continue to manual extraction
  }

  // Manual extraction for AbstractType instances
  // Check if it's Map-like (has _map with entries)
  if (sharedType._map && sharedType._map.size > 0) {
    const result = {};
    for (const [mapKey, item] of sharedType._map.entries()) {
      if (!item || !item.content) continue;
      try {
        const contentArr = item.content.getContent();
        if (contentArr.length === 0) {
          result[mapKey] = null;
        } else if (contentArr.length === 1) {
          const val = contentArr[0];
          // Recursively extract nested Yjs types
          result[mapKey] = val && typeof val === 'object' && val._map !== undefined
            ? extractYjsContent(val)
            : val;
        } else {
          result[mapKey] = contentArr.map(v =>
            v && typeof v === 'object' && v._map !== undefined ? extractYjsContent(v) : v
          );
        }
      } catch {
        result[mapKey] = null;
      }
    }
    return result;
  }

  // Check if it's Array-like (has _start linked list)
  if (sharedType._start !== undefined && sharedType._start !== null) {
    const result = [];
    let current = sharedType._start;
    while (current) {
      if (current.content && !current.deleted) {
        try {
          const contentArr = current.content.getContent();
          for (const val of contentArr) {
            // Recursively extract nested Yjs types
            result.push(val && typeof val === 'object' && val._map !== undefined
              ? extractYjsContent(val)
              : val);
          }
        } catch {
          // Skip invalid items
        }
      }
      current = current.right;
    }
    return result;
  }

  // Empty or unknown type
  return sharedType._map ? {} : []
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
        const metaPath = join(IMAGES_DIR, `${sanitizedId}.meta.json`);

        // Idempotency: Skip if already exists
        if (existsSync(targetPath)) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ success: true, id: sanitizedId, existed: true }));
          throw null;
        }

        await rename(imageFile.filepath, targetPath);

        // Store metadata (MIME type)
        if (imageFile.mimetype) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(metaPath, JSON.stringify({ mimeType: imageFile.mimetype }));
        }

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

        // Filter out .meta.json files from listing
        const imageFiles = files.filter(f => !f.endsWith('.meta.json'));

        const images = await Promise.all(
          imageFiles.map(async (name) => {
            const filePath = join(IMAGES_DIR, name);
            const stats = await stat(filePath);
            return { id: name, size: stats.size, modified: stats.mtime };
          })
        );
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ count: images.length, images }));
        throw null;
      } catch (err) {
        if (err === null) throw null;
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
      const metaPath = join(IMAGES_DIR, `${sanitizedId}.meta.json`);

      if (!existsSync(filePath)) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Image not found" }));
        throw null;
      }

      // Try to read metadata for Content-Type
      let contentType = "image/webp"; // Default to WebP
      try {
        if (existsSync(metaPath)) {
          const metaContent = await readFile(metaPath, "utf-8");
          const meta = JSON.parse(metaContent);
          if (meta.mimeType) contentType = meta.mimeType;
        }
      } catch (e) {
        // Ignore metadata read errors
      }

      response.writeHead(200, { "Content-Type": contentType });
      createReadStream(filePath).pipe(response);
      throw null;
    }

    // --- REST API: Admin - Database Info ---
    if (request.method === "GET" && pathname === "/api/admin/db-info") {
      if (!checkAuth(request)) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        throw null;
      }

      try {
        // Check if database exists
        if (!existsSync(DB_PATH)) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({
            dbSize: 0,
            documentCount: 0,
            totalDataSize: 0,
            documents: [],
          }));
          throw null;
        }

        // Get database file size
        const dbStats = await stat(DB_PATH);
        const dbSize = dbStats.size;

        // Open database and read documents
        const db = new DatabaseSync(DB_PATH, { readOnly: true });

        // Check if documents table exists
        const tableExists = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'"
        ).get();

        if (!tableExists) {
          db.close();
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({
            dbSize,
            documentCount: 0,
            totalDataSize: 0,
            documents: [],
          }));
          throw null;
        }

        const rows = db.prepare("SELECT name, data FROM documents").all();
        db.close();

        let totalDataSize = 0;
        const documents = rows.map((row) => {
          const data = row.data;
          const dataSize = data ? data.byteLength : 0;
          totalDataSize += dataSize;

          // Decode Yjs document to count shared types
          let sharedTypes = 0;
          try {
            const ydoc = new Y.Doc();
            Y.applyUpdate(ydoc, new Uint8Array(data));
            sharedTypes = ydoc.share.size;
            ydoc.destroy();
          } catch (e) {
            // Ignore decode errors
          }

          return {
            name: row.name,
            dataSize,
            sharedTypes,
          };
        });

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          dbSize,
          documentCount: documents.length,
          totalDataSize,
          documents,
        }));
        throw null;
      } catch (err) {
        if (err === null) throw null;
        console.error("Admin db-info error:", err);
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Failed to read database info" }));
        throw null;
      }
    }

    // --- REST API: Admin - Get Document Content ---
    if (request.method === "GET" && pathname.startsWith("/api/admin/documents/")) {
      if (!checkAuth(request)) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        throw null;
      }

      const docName = decodeURIComponent(pathname.replace("/api/admin/documents/", ""));

      try {
        if (!existsSync(DB_PATH)) {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Database not found" }));
          throw null;
        }

        const db = new DatabaseSync(DB_PATH, { readOnly: true });
        const row = db.prepare("SELECT name, data FROM documents WHERE name = ?").get(docName);
        db.close();

        if (!row) {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Document not found" }));
          throw null;
        }

        const data = new Uint8Array(row.data);
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, data);

        // Extract all shared types content
        const content = {};
        const sharedTypeNames = [];

        for (const [key, sharedType] of ydoc.share.entries()) {
          sharedTypeNames.push(key);
          content[key] = extractYjsContent(sharedType);
        }

        ydoc.destroy();

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          name: docName,
          binarySize: data.byteLength,
          sharedTypeNames,
          content,
        }));
        throw null;
      } catch (err) {
        if (err === null) throw null;
        console.error("Admin document error:", err);
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Failed to read document" }));
        throw null;
      }
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

      if (pathname === "/admin" || pathname === "/admin.html") {
        const content = await readFile(adminFilePath, "utf-8");
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