import { createReadStream } from "node:fs";
import { readdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  badRequest,
  internalServerError,
  notFound,
  payloadTooLarge,
} from "../lib/api.js";
import { decodeDocName, ensureDbExistsOr404, requireAuth, withDb } from "../lib/db.js";
import {
  DEFAULT_MAX_DOC_DECODE_BYTES,
  createDocTooLargeMessage,
  isDocTooLargeToDecode,
  toByteLength,
} from "../lib/doc.js";
import { parseBool } from "../lib/env.js";
import { readJsonOrNull, statOrNull } from "../lib/fs.js";
import { readJsonBody } from "../lib/http.js";
import { json, RESPONSE_SENT } from "../lib/responses.js";
import { getContent, getWorkspaceSummary } from "../yjs/inspect.js";

const BACKUP_FILE_RE = /^backup-[0-9A-Za-z._-]+\.sqlite$/;
const BACKUP_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

const removeBackupArtifacts = async (filePath) => {
  await Promise.allSettled([
    unlink(filePath),
    ...BACKUP_SIDECAR_SUFFIXES.map((suffix) => unlink(`${filePath}${suffix}`)),
  ]);
};

const listBackups = async (backupDir) => {
  const names = await readdir(backupDir).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });

  const backups = [];
  for (const name of names) {
    if (!BACKUP_FILE_RE.test(name) || name.includes("..")) continue;
    const fullPath = join(backupDir, name);
    const stats = await statOrNull(fullPath);
    if (!stats?.isFile?.()) continue;
    if (stats.size <= 0) {
      await removeBackupArtifacts(fullPath);
      continue;
    }

    const sidecars = {
      wal: 0,
      shm: 0,
      journal: 0,
    };
    let totalSizeBytes = stats.size;

    const walStats = await statOrNull(`${fullPath}-wal`);
    if (walStats?.isFile?.()) {
      sidecars.wal = walStats.size;
      totalSizeBytes += walStats.size;
    }

    const shmStats = await statOrNull(`${fullPath}-shm`);
    if (shmStats?.isFile?.()) {
      sidecars.shm = shmStats.size;
      totalSizeBytes += shmStats.size;
    }

    const journalStats = await statOrNull(`${fullPath}-journal`);
    if (journalStats?.isFile?.()) {
      sidecars.journal = journalStats.size;
      totalSizeBytes += journalStats.size;
    }

    backups.push({
      file: name,
      sizeBytes: stats.size,
      sidecars,
      totalSizeBytes,
      createdAt: new Date(stats.mtimeMs).toISOString(),
      mtimeMs: stats.mtimeMs,
    });
  }

  backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return backups.map((backup) => ({
    file: backup.file,
    sizeBytes: backup.sizeBytes,
    totalSizeBytes: backup.totalSizeBytes,
    sidecars: backup.sidecars,
    createdAt: backup.createdAt,
  }));
};

const sanitizeBackupFile = (rawValue, response) => {
  const file = String(rawValue ?? "").trim();
  if (!file) return null;
  if (basename(file) !== file) {
    badRequest(response, "Invalid backup file");
  }
  if (!BACKUP_FILE_RE.test(file) || file.includes("..")) {
    badRequest(response, "Invalid backup file");
  }
  return file;
};

const getDocumentMetaOr404 = (db, docName, response) => {
  const row = db
    .prepare("SELECT name, length(data) AS dataSize FROM documents WHERE name = ?")
    .get(docName);
  if (!row) {
    notFound(response, "Document not found");
  }
  return row;
};

const getDocumentMetaOrNull = (db, docName) =>
  db
    .prepare("SELECT name, length(data) AS dataSize FROM documents WHERE name = ?")
    .get(docName) ?? null;

const getDocumentDataOrNull = (db, docName) =>
  db.prepare("SELECT data FROM documents WHERE name = ?").get(docName) ?? null;

/**
 * Return cached doc metadata, lazily decoding from binary if workspaceName is missing.
 * Returns the cached entry (or null) — never throws.
 */
const ensureCachedMeta = (cache, dataStmt, name, dataSize, maxDocDecodeBytes) => {
  if (!cache) return null;
  const existing = cache.get(name);
  if (existing?.workspaceName) return existing;
  if (dataSize <= 0 || isDocTooLargeToDecode(dataSize, maxDocDecodeBytes)) return existing;

  try {
    const dataRow = dataStmt?.get(name);
    if (!dataRow?.data) return existing;

    const summary = getWorkspaceSummary(dataRow.data);
    const wName = summary.workspace?.name ?? null;
    if (!wName) return existing;

    cache.set(name, {
      workspaceName: wName,
      projectCount: summary.projectCount ?? existing?.projectCount ?? 0,
    });
    return cache.get(name);
  } catch {
    return existing;
  }
};

const handleDbInfo = async ({
  request,
  response,
  url,
  dbPath,
  checkAuth,
  maxDocDecodeBytes = DEFAULT_MAX_DOC_DECODE_BYTES,
  docMetaCache,
}) => {
  requireAuth(request, response, checkAuth);

  // Computing summaries requires loading & decoding every Yjs document, which can be
  // expensive and may OOM on small containers. Default to a light listing.
  const includeSummaries = parseBool(url?.searchParams?.get("include_summaries"), false);

  try {
    const dbStats = await statOrNull(dbPath);
    if (!dbStats) {
      json(response, 200, {
        dbSize: 0,
        dbSidecarsSize: 0,
        dbTotalSize: 0,
        dbSidecars: [],
        documentCount: 0,
        totalDataSize: 0,
        documents: [],
      });
    }

    const dbSize = dbStats.size;
    const sidecars = [];
    let dbSidecarsSize = 0;

    const walStats = await statOrNull(`${dbPath}-wal`);
    if (walStats?.isFile?.()) {
      sidecars.push({ file: `${basename(dbPath)}-wal`, sizeBytes: walStats.size });
      dbSidecarsSize += walStats.size;
    }

    const shmStats = await statOrNull(`${dbPath}-shm`);
    if (shmStats?.isFile?.()) {
      sidecars.push({ file: `${basename(dbPath)}-shm`, sizeBytes: shmStats.size });
      dbSidecarsSize += shmStats.size;
    }

    const journalStats = await statOrNull(`${dbPath}-journal`);
    if (journalStats?.isFile?.()) {
      sidecars.push({ file: `${basename(dbPath)}-journal`, sizeBytes: journalStats.size });
      dbSidecarsSize += journalStats.size;
    }

    const dbTotalSize = dbSize + dbSidecarsSize;

    withDb(dbPath, { readOnly: true }, (db) => {
      const tableExists = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'"
        )
        .get();

      if (!tableExists) {
        json(response, 200, {
          dbSize,
          dbSidecarsSize,
          dbTotalSize,
          dbSidecars: sidecars,
          documentCount: 0,
          totalDataSize: 0,
          documents: [],
        });
      }

      let totalDataSize = 0;
      const documents = [];

      if (!includeSummaries) {
        const stmt = db.prepare("SELECT name, length(data) AS dataSize FROM documents");
        const dataStmt = docMetaCache
          ? db.prepare("SELECT data FROM documents WHERE name = ?")
          : null;

        for (const row of stmt.iterate()) {
          const dataSize = toByteLength(row?.dataSize);
          totalDataSize += dataSize;

          const cached = ensureCachedMeta(
            docMetaCache, dataStmt, row.name, dataSize, maxDocDecodeBytes,
          );

          documents.push({
            name: row.name,
            workspaceName: cached?.workspaceName ?? null,
            dataSize,
          });
        }

        json(response, 200, {
          dbSize,
          dbSidecarsSize,
          dbTotalSize,
          dbSidecars: sidecars,
          documentCount: documents.length,
          totalDataSize,
          documents,
        });
      }

      const stmt = db.prepare("SELECT name, length(data) AS dataSize FROM documents");
      const dataStmt = db.prepare("SELECT data FROM documents WHERE name = ?");

      for (const row of stmt.iterate()) {
        const dataSize = toByteLength(row?.dataSize);
        totalDataSize += dataSize;

        if (isDocTooLargeToDecode(dataSize, maxDocDecodeBytes)) {
          documents.push({
            name: row.name,
            dataSize,
            sharedTypes: null,
            workspace: null,
            projectCount: null,
            lastUpdatedAt: null,
            summarySkipped: true,
            summaryReason: "document_too_large",
          });
          continue;
        }

        const dataRow = dataStmt.get(row.name);
        const summary = getWorkspaceSummary(dataRow?.data);

        documents.push({
          name: row.name,
          dataSize,
          sharedTypes: summary.sharedTypes,
          workspace: summary.workspace,
          projectCount: summary.projectCount,
          lastUpdatedAt: summary.lastUpdatedAt,
        });
      }

      json(response, 200, {
        dbSize,
        dbSidecarsSize,
        dbTotalSize,
        dbSidecars: sidecars,
        documentCount: documents.length,
        totalDataSize,
        documents,
      });
    });
  } catch (err) {
    if (err === RESPONSE_SENT) throw err;
    console.error("Admin db-info error:", err);
    internalServerError(response, "Failed to read database info");
  }
};

const handleBackups = async ({ request, response, backupDir, backupService, checkAuth }) => {
  requireAuth(request, response, checkAuth);

  try {
    const backups = await listBackups(backupDir);
    const totalSizeBytes = backups.reduce(
      (sum, backup) => sum + (backup.totalSizeBytes ?? backup.sizeBytes ?? 0),
      0
    );
    const health = typeof backupService?.getAutoBackupHealth === "function"
      ? backupService.getAutoBackupHealth()
      : null;
    const effectiveHealth = health
      ? {
        ...health,
        lastSuccessAt: health.lastSuccessAt || backups[0]?.createdAt || null,
      }
      : null;
    json(response, 200, { backups, totalSizeBytes, health: effectiveHealth });
  } catch (err) {
    if (err === RESPONSE_SENT) throw err;
    console.error("Admin backups error:", err);
    internalServerError(response, "Failed to read backups");
  }
};

const handleCreateBackup = async ({ request, response, backupService, checkAuth }) => {
  requireAuth(request, response, checkAuth);

  try {
    const backupFile = await backupService.forceBackup();
    json(response, 201, { success: true, file: backupFile });
  } catch (err) {
    if (err === RESPONSE_SENT) throw err;
    if (err.message === "Backup already in progress" || err.message === "Restore in progress") {
      json(response, 409, { error: err.message });
    }
    console.error("Admin create-backup error:", err);
    internalServerError(response, err.message || "Failed to create backup");
  }
};

const handleBackupDownload = async ({ request, response, backupDir, checkAuth, file }) => {
  requireAuth(request, response, checkAuth);

  const sanitized = sanitizeBackupFile(file, response);
  if (!sanitized) {
    badRequest(response, "Invalid backup file");
  }

  const filePath = join(backupDir, sanitized);
  const stats = await statOrNull(filePath);
  if (!stats || !stats.isFile()) {
    notFound(response, "Backup not found");
  }
  if (stats.size <= 0) {
    await removeBackupArtifacts(filePath);
    notFound(response, "Backup not found");
  }

  response.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": stats.size,
    "Content-Disposition": `attachment; filename="${sanitized}"`,
    "Cache-Control": "no-store",
  });

  try {
    await pipeline(createReadStream(filePath), response);
  } catch (error) {
    if (error?.code === "ERR_STREAM_PREMATURE_CLOSE" || error?.code === "ECONNRESET") {
      throw RESPONSE_SENT;
    }
    console.error("Backup download stream error:", error);
  }

  throw RESPONSE_SENT;
};

const handleGetBackupSettings = async ({ request, response, backupSettingsPath, checkAuth }) => {
  requireAuth(request, response, checkAuth);

  try {
    const settings = await readJsonOrNull(backupSettingsPath);
    const mode = settings && typeof settings.mode === "string" ? settings.mode : "count";
    const value = settings && Number.isFinite(settings.value) && settings.value > 0 ? settings.value : 10;
    const rawInterval = Number(settings?.intervalMinutes);
    const intervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 30;
    json(response, 200, { mode, value, intervalMinutes });
  } catch (err) {
    if (err === RESPONSE_SENT) throw err;
    console.error("Admin backup-settings read error:", err);
    internalServerError(response, "Failed to read backup settings");
  }
};

const handlePutBackupSettings = async ({ request, response, backupSettingsPath, checkAuth }) => {
  requireAuth(request, response, checkAuth);

  try {
    const body = await readJsonBody(request, response);
    const mode = typeof body.mode === "string" ? body.mode.trim() : "";

    if (!["none", "days", "count", "size"].includes(mode)) {
      badRequest(response, 'Invalid mode. Must be "none", "days", "count", or "size".');
    }

    let value = 0;
    if (mode !== "none") {
      value = Number(body.value);
      if (!Number.isFinite(value) || value <= 0) {
        badRequest(response, "Value must be a positive number");
      }
      if (mode === "count" || mode === "days") {
        value = Math.floor(value);
      }
    }

    let intervalMinutes = Math.floor(Number(body.intervalMinutes));
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
      // Preserve existing interval if not provided; fall back to 30
      const current = await readJsonOrNull(backupSettingsPath);
      const currentInterval = Number(current?.intervalMinutes);
      intervalMinutes = Number.isFinite(currentInterval) && currentInterval > 0 ? currentInterval : 30;
    }

    const payload = { mode, value, intervalMinutes, updatedAt: new Date().toISOString() };
    await writeFile(backupSettingsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

    json(response, 200, { mode, value, intervalMinutes });
  } catch (err) {
    if (err === RESPONSE_SENT) throw err;
    console.error("Admin backup-settings write error:", err);
    internalServerError(response, "Failed to save backup settings");
  }
};

const handleDocGet = async ({
  request,
  response,
  url,
  dbPath,
  backupDir,
  checkAuth,
  maxDocDecodeBytes = DEFAULT_MAX_DOC_DECODE_BYTES,
  encodedName,
}) => {
  requireAuth(request, response, checkAuth);
  const docName = decodeDocName(encodedName, response);

  const backupFile = sanitizeBackupFile(url.searchParams.get("backup"), response);
  const isBackup = Boolean(backupFile);
  const effectiveDbPath = isBackup ? join(backupDir, backupFile) : dbPath;

  try {
    if (isBackup) {
      const stats = await statOrNull(effectiveDbPath);
      if (!stats) {
        notFound(response, "Backup not found");
      }
    } else {
      await ensureDbExistsOr404(effectiveDbPath, response);
    }

    withDb(effectiveDbPath, { readOnly: true }, (db) => {
      const meta = isBackup
        ? getDocumentMetaOrNull(db, docName)
        : getDocumentMetaOr404(db, docName, response);

      if (!meta) {
        json(response, 200, {
          name: docName,
          source: "backup",
          backup: backupFile,
          exists: false,
          binarySize: 0,
          sharedTypeNames: [],
          content: {},
        });
      }

      const binarySize = toByteLength(meta.dataSize);
      if (isDocTooLargeToDecode(binarySize, maxDocDecodeBytes)) {
        payloadTooLarge(
          response,
          createDocTooLargeMessage(docName, binarySize, maxDocDecodeBytes),
        );
      }

      const dataRow = getDocumentDataOrNull(db, docName);
      if (!dataRow) {
        if (!isBackup) {
          notFound(response, "Document not found");
        }

        json(response, 200, {
          name: docName,
          source: isBackup ? "backup" : "current",
          backup: isBackup ? backupFile : null,
          exists: false,
          binarySize: 0,
          sharedTypeNames: [],
          content: {},
        });
      }

      const { sharedTypeNames, content } = getContent(dataRow.data);

      json(response, 200, {
        name: docName,
        source: isBackup ? "backup" : "current",
        backup: isBackup ? backupFile : null,
        exists: true,
        binarySize,
        sharedTypeNames,
        content,
      });
    });
  } catch (err) {
    if (err === RESPONSE_SENT) throw err;
    console.error("Admin document error:", err);
    internalServerError(response, "Failed to read document");
  }
};

const handleDocDelete = async ({
  request,
  response,
  dbPath,
  checkAuth,
  encodedName,
  docMetaCache,
}) => {
  requireAuth(request, response, checkAuth);
  const docName = decodeDocName(encodedName, response);

  try {
    await ensureDbExistsOr404(dbPath, response);

    withDb(dbPath, {}, (db) => {
      const result = db
        .prepare("DELETE FROM documents WHERE name = ?")
        .run(docName);

      if (result.changes === 0) {
        notFound(response, "Document not found");
      }

      docMetaCache?.delete(docName);
      json(response, 200, { success: true, deleted: docName });
    });
  } catch (err) {
    if (err === RESPONSE_SENT) throw err;
    console.error("Admin delete error:", err);
    internalServerError(response, "Failed to delete document");
  }
};

const RESTORE_EXIT_CODE = 75;

const handleRestoreBackup = async ({
  request,
  response,
  backupService,
  checkAuth,
  hocuspocusServer,
  file,
}) => {
  requireAuth(request, response, checkAuth);

  const sanitized = sanitizeBackupFile(file, response);
  if (!sanitized) {
    badRequest(response, "Invalid backup file");
  }

  let hocuspocusDestroyed = false;

  try {
    // Destroy Hocuspocus BEFORE touching the DB file.
    // This closes all WebSocket connections and releases the SQLite handle,
    // which is required on Windows (EBUSY) and prevents data races on Linux.
    if (hocuspocusServer && typeof hocuspocusServer.destroy === "function") {
      console.log("🔒 Stopping Hocuspocus before restore...");
      await hocuspocusServer.destroy();
      hocuspocusDestroyed = true;
    }

    const result = await backupService.restoreBackup(sanitized);

    console.log(`✅ Restore complete: ${result.restoredFrom} (pre-restore: ${result.preRestoreBackup})`);

    // Exit the process AFTER the HTTP response is fully flushed to the client.
    response.on("finish", () => {
      console.log("🔄 Restarting server after restore...");
      process.exit(RESTORE_EXIT_CODE);
    });

    json(response, 200, {
      success: true,
      restoredFrom: result.restoredFrom,
      preRestoreBackup: result.preRestoreBackup,
      message: "Database restored. Server will restart now.",
    });
  } catch (err) {
    if (err === RESPONSE_SENT) throw err;

    const msg = err.message || "Failed to restore backup";
    console.error("Admin restore error:", err);

    // If Hocuspocus was already destroyed, the server is in a zombie state.
    // Force exit so the process manager restarts it cleanly.
    if (hocuspocusDestroyed) {
      response.on("finish", () => {
        console.error("🔄 Hocuspocus was destroyed before restore failed — forcing restart.");
        process.exit(RESTORE_EXIT_CODE);
      });
    }

    if (msg === "Backup not found") {
      notFound(response, msg);
    }
    if (msg === "Restore already in progress" || msg === "Backup in progress, try again shortly") {
      json(response, 409, { error: msg });
    }
    if (msg.includes("integrity check failed")) {
      badRequest(response, msg);
    }
    internalServerError(response, msg);
  }
};

export const handleAdminRequest = async ({
  request,
  response,
  url,
  pathname,
  dbPath,
  backupDir,
  backupSettingsPath,
  backupService,
  checkAuth,
  maxDocDecodeBytes,
  docMetaCache,
  hocuspocusServer,
}) => {
  if (request.method === "GET" && pathname === "/api/admin/db-info") {
    await handleDbInfo({
      request,
      response,
      url,
      dbPath,
      checkAuth,
      maxDocDecodeBytes,
      docMetaCache,
    });
    return;
  }

  if (pathname === "/api/admin/backups") {
    if (request.method === "GET") {
      await handleBackups({ request, response, backupDir, backupService, checkAuth });
      return;
    }
    if (request.method === "POST") {
      await handleCreateBackup({ request, response, backupService, checkAuth });
      return;
    }
  }

  const downloadMatch = pathname.match(/^\/api\/admin\/backups\/([^/]+)\/download$/);
  if (request.method === "GET" && downloadMatch) {
    await handleBackupDownload({
      request,
      response,
      backupDir,
      checkAuth,
      file: decodeURIComponent(downloadMatch[1]),
    });
    return;
  }

  const restoreMatch = pathname.match(/^\/api\/admin\/backups\/([^/]+)\/restore$/);
  if (request.method === "POST" && restoreMatch) {
    await handleRestoreBackup({
      request,
      response,
      backupService,
      checkAuth,
      hocuspocusServer,
      file: decodeURIComponent(restoreMatch[1]),
    });
    return;
  }

  if (pathname === "/api/admin/backup-settings") {
    if (request.method === "GET") {
      await handleGetBackupSettings({ request, response, backupSettingsPath, checkAuth });
      return;
    }
    if (request.method === "PUT") {
      await handlePutBackupSettings({ request, response, backupSettingsPath, checkAuth });
      return;
    }
  }

  const match = pathname.match(/^\/api\/admin\/documents\/([^/]+)$/);
  if (!match) return;

  const encodedName = match[1];

  if (request.method === "GET") {
    await handleDocGet({
      request,
      response,
      url,
      dbPath,
      backupDir,
      checkAuth,
      maxDocDecodeBytes,
      encodedName,
    });
    return;
  }

  if (request.method === "DELETE") {
    await handleDocDelete({
      request,
      response,
      dbPath,
      checkAuth,
      encodedName,
      docMetaCache,
    });
    return;
  }
};
