import "dotenv/config";
import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";
import { Logger } from "@hocuspocus/extension-logger";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackupService } from "./services/backup.js";

const port = Number(process.env.PORT ?? 8080);
const __dirname = dirname(fileURLToPath(import.meta.url));
const demoFilePath = join(__dirname, "index.html");
const inspectorFilePath = join(__dirname, "inspector.html");

const AUTH_TOKEN = process.env.HOCUSPOCUS_TOKEN ?? "focus-compass-demo-token";
const DB_PATH = process.env.DB_PATH ?? "./data/db.sqlite";

const backupService = new BackupService({
  dbPath: DB_PATH,
  backupDir: "./backups",
  intervalMinutes: Number(process.env.BACKUP_INTERVAL_MINUTES ?? 60),
  retentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 7),
});

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
    if (request.method !== "GET") return;

    const host = request.headers.host ?? "localhost";
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", `http://${host}`).pathname;
    } catch {
      return;
    }

    try {
      if (pathname === "/" || pathname === "/index.html") {
        const content = await readFile(demoFilePath, "utf-8");
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(content);
        // Hocuspocus convention: throw null to signal request is handled
        throw null;
      }

      if (pathname === "/inspector" || pathname === "/inspector.html") {
        const content = await readFile(inspectorFilePath, "utf-8");
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(content);
        throw null;
      }
    } catch (error) {
      // Re-throw null (Hocuspocus convention)
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

try {
  await server.listen();
  console.log(`✅ Server running at http://localhost:${port}`);
} catch (error) {
  console.error("❌ Failed to start server:", error);
  process.exit(1);
}