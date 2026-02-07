import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  badRequest,
  internalServerError,
  notFound,
} from "../lib/api.js";
import { decodeDocName, ensureDbExistsOr404, requireAuth, withDb } from "../lib/db.js";
import { statOrNull } from "../lib/fs.js";
import { json } from "../lib/responses.js";
import { getContent, getWorkspaceSummary } from "../yjs/inspect.js";

const BACKUP_FILE_RE = /^backup-[0-9A-Za-z._-]+\.sqlite$/;

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

const getDocumentRowOr404 = (db, docName, response) => {
  const row = db
    .prepare("SELECT name, data FROM documents WHERE name = ?")
    .get(docName);
  if (!row) {
    notFound(response, "Document not found");
  }
  return row;
};

const getDocumentRowOrNull = (db, docName) =>
  db.prepare("SELECT name, data FROM documents WHERE name = ?").get(docName) ?? null;

const handleDbInfo = async ({ request, response, dbPath, checkAuth }) => {
  requireAuth(request, response, checkAuth);

  try {
    const dbStats = await statOrNull(dbPath);
    if (!dbStats) {
      json(response, 200, {
        dbSize: 0,
        dbSidecarsSize: 0,
        dbTotalSize: 0,
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

      const rows = db.prepare("SELECT name, data FROM documents").all();

      let totalDataSize = 0;
      const documents = rows.map((row) => {
        const data = row.data;
        const dataSize = data ? data.byteLength : 0;
        totalDataSize += dataSize;

        const summary = getWorkspaceSummary(data);

        return {
          name: row.name,
          dataSize,
          sharedTypes: summary.sharedTypes,
          workspace: summary.workspace,
          projectCount: summary.projectCount,
          lastUpdatedAt: summary.lastUpdatedAt,
        };
      });

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
    if (err === null) throw null;
    console.error("Admin db-info error:", err);
    internalServerError(response, "Failed to read database info");
  }
};

const handleBackups = async ({ request, response, backupDir, checkAuth }) => {
  requireAuth(request, response, checkAuth);

  try {
    const backups = await listBackups(backupDir);
    const totalSizeBytes = backups.reduce(
      (sum, backup) => sum + (backup.totalSizeBytes ?? backup.sizeBytes ?? 0),
      0
    );
    json(response, 200, { backups, totalSizeBytes });
  } catch (err) {
    if (err === null) throw null;
    console.error("Admin backups error:", err);
    internalServerError(response, "Failed to read backups");
  }
};

const handleDocGet = async ({
  request,
  response,
  url,
  dbPath,
  backupDir,
  checkAuth,
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
      const row = isBackup
        ? getDocumentRowOrNull(db, docName)
        : getDocumentRowOr404(db, docName, response);

      if (!row) {
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

      const binarySize = row.data ? row.data.byteLength : 0;
      const { sharedTypeNames, content } = getContent(row.data);

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
    if (err === null) throw null;
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

      json(response, 200, { success: true, deleted: docName });
    });
  } catch (err) {
    if (err === null) throw null;
    console.error("Admin delete error:", err);
    internalServerError(response, "Failed to delete document");
  }
};

export const handleAdminRequest = async ({
  request,
  response,
  url,
  pathname,
  dbPath,
  backupDir,
  checkAuth,
}) => {
  if (request.method === "GET" && pathname === "/api/admin/db-info") {
    await handleDbInfo({ request, response, dbPath, checkAuth });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/backups") {
    await handleBackups({ request, response, backupDir, checkAuth });
    return;
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
      encodedName,
    });
    return;
  }

  if (request.method === "DELETE") {
    await handleDocDelete({ request, response, dbPath, checkAuth, encodedName });
    return;
  }
};
