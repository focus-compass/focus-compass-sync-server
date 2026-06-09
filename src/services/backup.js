import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const BACKUP_RE = /^backup-[0-9A-Za-z._-]+\.sqlite$/;

// Deletes a file, treating "already gone" (ENOENT) as success but letting real
// failures (permissions, locks) surface so callers can log or react to them.
const unlinkIfExists = async (filePath) => {
    try {
        await unlink(filePath);
    } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
    }
};

/**
 * Service to handle SQLite database backups.
 * Creates a copy of the database file at specified intervals and cleans up old backups.
 */
export class BackupService {
    /**
     * @param {Object} config
     * @param {string} config.dbPath - Path to the source SQLite database
     * @param {string} [config.backupDir="./backups"] - Directory to store backups
     * @param {string|null} [config.settingsFilePath=null] - Path to backup-settings.json
     */
    constructor(config) {
        this.dbPath = config.dbPath;
        this.backupDir = config.backupDir ?? "./backups";
        this.settingsFilePath = config.settingsFilePath ?? null;

        this.lastBackupTime = 0;
        this.lastAutoBackupAttemptTime = 0;
        this.isBackingUp = false;
        this.isRestoring = false;
        this.isAutoBackupQueued = false;
        this.autoBackupHealth = {
            status: "ok",
            consecutiveFailures: 0,
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: "",
        };

        this.ready = this._ensureDir();
    }

    async _ensureDir() {
        try {
            await mkdir(this.backupDir, { recursive: true });
        } catch {
            // Directory may already exist
        }
    }

    /**
     * Attempts to create a backup if the interval has passed.
     * Safe to call frequently.
     * Reads intervalMinutes from settings (default 30).
     */
    async tryBackup() {
        if (this.isBackingUp || this.isRestoring) return;

        try {
            await this.ready;

            const settings = await this._readSettings();
            const raw = Number(settings?.intervalMinutes);
            const intervalMinutes = Number.isFinite(raw) && raw > 0 ? raw : 30;

            const now = Date.now();
            const intervalMs = intervalMinutes * 60 * 1000;

            if (now - this.lastAutoBackupAttemptTime < intervalMs) return;

            this.lastAutoBackupAttemptTime = now;

            await this._createBackup("backup", { settings });
            this._markBackupSuccess();
        } catch (error) {
            this._markAutoBackupFailure(error);
        }
    }

    /**
     * Queues an automatic backup outside the document store hook so writes do
     * not wait for snapshot/compaction work.
     */
    requestAutoBackup() {
        if (this.isAutoBackupQueued) return;

        this.isAutoBackupQueued = true;
        setTimeout(() => {
            this.isAutoBackupQueued = false;
            void this.tryBackup();
        }, 0);
    }

    /**
     * Forces a backup immediately, bypassing the interval check.
     * Returns the backup filename on success, or throws on failure.
     * @returns {Promise<string>} backup filename
     */
    async forceBackup() {
        await this.ready;

        if (this.isBackingUp) {
            throw new Error("Backup already in progress");
        }
        if (this.isRestoring) {
            throw new Error("Restore in progress");
        }

        const backupFile = await this._createBackup();
        this._markBackupSuccess();
        return backupFile;
    }

    getAutoBackupHealth() {
        return {
            status: this.autoBackupHealth.consecutiveFailures > 0 ? "degraded" : "ok",
            consecutiveFailures: this.autoBackupHealth.consecutiveFailures,
            lastAttemptAt: this.autoBackupHealth.lastAttemptAt,
            lastSuccessAt: this.autoBackupHealth.lastSuccessAt,
            lastFailureAt: this.autoBackupHealth.lastFailureAt,
            lastError: this.autoBackupHealth.lastError,
        };
    }

    _markBackupSuccess() {
        const nowIso = new Date().toISOString();
        this.autoBackupHealth = {
            ...this.autoBackupHealth,
            status: "ok",
            consecutiveFailures: 0,
            lastAttemptAt: nowIso,
            lastSuccessAt: nowIso,
            lastError: "",
        };
    }

    _markAutoBackupFailure(error) {
        const nowIso = new Date().toISOString();
        const message = String(error?.message || error || "Auto-backup failed");
        this.autoBackupHealth = {
            ...this.autoBackupHealth,
            status: "degraded",
            consecutiveFailures: this.autoBackupHealth.consecutiveFailures + 1,
            lastAttemptAt: nowIso,
            lastFailureAt: nowIso,
            lastError: message,
        };
    }

    /**
     * Creates an atomic, compact backup in two phases:
     * 1. Take a live snapshot with SQLite's backup API.
     * 2. Run VACUUM INTO on that offline snapshot to purge free pages and
     *    deleted-content traces from the final backup artifact.
     *
     * @param {string} [prefix="backup"] - Filename prefix
     * @param {Object} [options]
     * @param {boolean} [options.skipCleanup=false] - Skip old-backup cleanup
     *   (for pre-restore snapshots where we must not delete the source backup)
     * @param {Object|null} [options.settings=null] - Pre-read settings to avoid re-reading the file
     * @returns {Promise<string>} backup filename
     */
    async _createBackup(
        prefix = "backup",
        { skipCleanup = false, settings = null } = {},
    ) {
        this.isBackingUp = true;
        let backupFile = null;
        let backupPath = null;
        let tempSnapshotPath = null;
        let tempBackupPath = null;

        try {
            // Skip if database doesn't exist yet
            try {
                await stat(this.dbPath);
            } catch (error) {
                if (error?.code === "ENOENT") throw new Error("Database does not exist yet");
                throw error;
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupBase = `${prefix}-${timestamp}`;
            backupFile = `${backupBase}.sqlite`;
            backupPath = join(this.backupDir, backupFile);
            tempSnapshotPath = join(this.backupDir, `${backupBase}.snapshot.sqlite`);
            tempBackupPath = join(this.backupDir, `${backupBase}.tmp.sqlite`);

            await this._copyDatabase(this.dbPath, tempSnapshotPath);
            await this._vacuumIntoBackup(tempSnapshotPath, tempBackupPath);
            await this._deleteDatabaseArtifacts(tempSnapshotPath).catch(() => {});
            tempSnapshotPath = null;

            const backupStats = await stat(tempBackupPath).catch(() => null);
            if (!backupStats?.isFile?.() || backupStats.size <= 0) {
                throw new Error("Backup file is empty");
            }

            await this._verifyIntegrity(tempBackupPath);

            await rename(tempBackupPath, backupPath);
            tempBackupPath = null;

            this.lastBackupTime = Date.now();

            if (!skipCleanup) {
                await this._cleanOldBackups(settings);
            }

            return backupFile;
        } catch (error) {
            if (tempSnapshotPath) {
                await this._deleteDatabaseArtifacts(tempSnapshotPath).catch(() => {});
            }
            if (tempBackupPath) {
                await this._deleteDatabaseArtifacts(tempBackupPath).catch(() => {});
            }
            if (backupPath) {
                await this._deleteDatabaseArtifacts(backupPath).catch(() => {});
            }
            console.error("❌ Backup failed:", error.message);
            throw error;
        } finally {
            this.isBackingUp = false;
        }
    }

    async _copyDatabase(sourcePath, targetPath) {
        await this._deleteDatabaseArtifacts(targetPath).catch(() => {});

        const sourceDb = new DatabaseSync(sourcePath);
        try {
            await sqliteBackup(sourceDb, targetPath);
        } catch (error) {
            throw new Error(`Live snapshot failed: ${error.message}`, { cause: error });
        } finally {
            sourceDb.close();
        }
    }

    async _vacuumIntoBackup(sourcePath, targetPath) {
        await this._deleteDatabaseArtifacts(targetPath).catch(() => {});

        const db = new DatabaseSync(sourcePath);
        try {
            db.exec(`VACUUM INTO '${BackupService._escapeSqlString(targetPath)}'`);
        } catch (error) {
            throw new Error(`Compact backup failed: ${error.message}`, { cause: error });
        } finally {
            try { db.close(); } catch { /* already closed */ }
        }

        await BackupService._removeSidecars(sourcePath).catch(() => {});
        await BackupService._removeSidecars(targetPath).catch(() => {});
    }

    /**
     * Verifies a SQLite file passes PRAGMA integrity_check.
     * @param {string} filePath - Absolute path to the .sqlite file
     * @param {boolean} [deleteOnFailure=true] - Delete the file if the check fails
     *   (useful for newly created backups; set to false when verifying existing files)
     */
    async _verifyIntegrity(filePath, deleteOnFailure = true) {
        const db = new DatabaseSync(filePath, { readOnly: true });
        let integrityError = null;
        let result = null;
        try {
            const row = db.prepare("PRAGMA integrity_check").get();
            result = row?.integrity_check ?? row?.["integrity_check"];
        } catch (error) {
            integrityError = error;
        } finally {
            try { db.close(); } catch { /* already closed */ }
        }

        // integrity_check can materialize transient WAL/SHM files even for a
        // clean backup; remove them so snapshots remain a single-file artifact.
        await BackupService._removeSidecars(filePath).catch(() => {});

        if (integrityError) {
            if (deleteOnFailure) {
                await this._deleteDatabaseArtifacts(filePath).catch(() => {});
            }
            throw integrityError;
        }

        if (result !== "ok") {
            if (deleteOnFailure) {
                await this._deleteDatabaseArtifacts(filePath).catch(() => {});
            }
            throw new Error(`Backup integrity check failed: ${result}`);
        }
    }

    async _readSettings() {
        if (!this.settingsFilePath) return null;
        try {
            const raw = await readFile(this.settingsFilePath, "utf-8");
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
            return null;
        }
    }

    async _deleteDatabaseArtifacts(filePath) {
        await unlinkIfExists(filePath);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
            await unlinkIfExists(`${filePath}${suffix}`);
        }
    }

    async _sizeOfBackup(filePath) {
        let total = 0;
        const mainStats = await stat(filePath).catch(() => null);
        if (mainStats) total += mainStats.size;
        // Legacy backups may still have sidecars from the old copyFile approach
        for (const suffix of ["-wal", "-shm", "-journal"]) {
            const s = await stat(`${filePath}${suffix}`).catch(() => null);
            if (s) total += s.size;
        }
        return total;
    }

    async _listBackupEntries() {
        const files = await readdir(this.backupDir);
        const entries = [];
        for (const file of files) {
            if (!BACKUP_RE.test(file)) continue;
            const filePath = join(this.backupDir, file);
            const stats = await stat(filePath).catch(() => null);
            if (!stats?.isFile?.()) continue;
            const totalSize = await this._sizeOfBackup(filePath);
            entries.push({ file, filePath, mtimeMs: stats.mtimeMs, totalSize });
        }
        // Sort oldest first for cleanup (delete from the beginning)
        entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
        return entries;
    }

    /**
     * Restores the database from a backup file.
     *
     * Steps:
     * 1. Verify the backup exists and passes integrity check.
     * 2. Create a pre-restore snapshot of the current DB (safety net).
     * 3. Replace the current DB file with the backup.
     * 4. Remove stale sidecars (-wal, -shm, -journal) from the current DB.
     *
     * **Important:** The caller MUST stop the Hocuspocus server (disconnect all
     * WebSocket clients) BEFORE calling this method, and restart the process
     * afterward so that Hocuspocus picks up the restored data.
     *
     * @param {string} backupFile - Filename of the backup (e.g. "backup-2025-03-16T12-00-00-000Z.sqlite")
     * @returns {Promise<{ restoredFrom: string, preRestoreBackup: string }>}
     */
    async restoreBackup(backupFile) {
        await this.ready;

        if (this.isRestoring) {
            throw new Error("Restore already in progress");
        }
        if (this.isBackingUp) {
            throw new Error("Backup in progress, try again shortly");
        }

        this.isRestoring = true;

        try {
            return await this._doRestore(backupFile);
        } finally {
            this.isRestoring = false;
        }
    }

    /** @private */
    async _doRestore(backupFile) {
        const backupPath = join(this.backupDir, backupFile);

        // 1. Verify backup exists
        const backupStats = await stat(backupPath).catch(() => null);
        if (!backupStats?.isFile?.()) {
            throw new Error("Backup not found");
        }

        // 2. Verify backup integrity before touching the live DB (do NOT delete on failure)
        await this._verifyIntegrity(backupPath, false);

        // 3. Create pre-restore snapshot of the current database.
        //    skipCleanup=true prevents _cleanOldBackups from deleting the source backup.
        let preRestoreBackup = null;
        try {
            const hasDb = await stat(this.dbPath).catch(() => null);
            if (hasDb) {
                preRestoreBackup = await this._createBackup("backup-pre-restore", { skipCleanup: true });
                console.log(`✅ Pre-restore snapshot created: ${preRestoreBackup}`);
            }
        } catch (error) {
            throw new Error(`Failed to create pre-restore snapshot: ${error.message}`);
        }

        // 4. Replace current DB: create a restored temp DB, swap it into place,
        //    then remove stale sidecars from the previous live database.
        const oldDbPath = `${this.dbPath}.old`;
        let tempRestorePath = `${this.dbPath}.restore.tmp`;
        try {
            await this._deleteDatabaseArtifacts(tempRestorePath).catch(() => {});

            await this._copyDatabase(backupPath, tempRestorePath);
            await BackupService._removeSidecars(backupPath).catch(() => {});
            await this._verifyIntegrity(tempRestorePath);

            // Move current DB out of the way
            const hasDb = await stat(this.dbPath).catch(() => null);
            if (hasDb) {
                await rename(this.dbPath, oldDbPath);
            }

            await rename(tempRestorePath, this.dbPath);
            tempRestorePath = null;

            // Remove stale sidecars from the live DB path
            await BackupService._removeSidecars(this.dbPath);

            // Clean up .old file (best-effort)
            await this._deleteDatabaseArtifacts(oldDbPath).catch(() => {});
        } catch (error) {
            // Attempt to roll back: restore the .old file if it exists
            try {
                if (tempRestorePath) {
                    await this._deleteDatabaseArtifacts(tempRestorePath).catch(() => {});
                }
                const hasOld = await stat(oldDbPath).catch(() => null);
                if (hasOld) {
                    await unlink(this.dbPath).catch(() => {});
                    await rename(oldDbPath, this.dbPath);
                }
            } catch {
                // Critical: rollback also failed — both files may be in a bad state
            }
            throw new Error(`Restore failed (rolled back): ${error.message}`);
        }

        return {
            restoredFrom: backupFile,
            preRestoreBackup: preRestoreBackup ?? null,
        };
    }

    /**
     * Removes WAL, SHM, and journal sidecars for a given DB path (best-effort).
     * @param {string} dbPath
     */
    static async _removeSidecars(dbPath) {
        for (const suffix of ["-wal", "-shm", "-journal"]) {
            await unlinkIfExists(`${dbPath}${suffix}`);
        }
    }

    static _escapeSqlString(value) {
        return String(value).replace(/'/g, "''");
    }

    async _cleanOldBackups(cachedSettings = null) {
        try {
            const settings = cachedSettings ?? await this._readSettings();
            const mode = settings?.mode || "count";
            const value = Number(settings?.value);
            const effectiveValue = Number.isFinite(value) && value > 0 ? value : 10;

            if (mode === "none") return;

            const entries = await this._listBackupEntries();

            if (mode === "days") {
                const maxAgeMs = Math.floor(effectiveValue) * 24 * 60 * 60 * 1000;
                const now = Date.now();
                for (const entry of entries) {
                    if (now - entry.mtimeMs > maxAgeMs) {
                        await this._deleteDatabaseArtifacts(entry.filePath);
                    }
                }
            } else if (mode === "count") {
                const maxCount = Math.floor(effectiveValue);
                while (entries.length > maxCount) {
                    const oldest = entries.shift();
                    await this._deleteDatabaseArtifacts(oldest.filePath);
                }
            } else if (mode === "size") {
                let totalBytes = entries.reduce((sum, e) => sum + e.totalSize, 0);
                // Always keep at least 1 backup even if it exceeds the size limit
                while (totalBytes > effectiveValue && entries.length > 1) {
                    const oldest = entries.shift();
                    await this._deleteDatabaseArtifacts(oldest.filePath);
                    totalBytes -= oldest.totalSize;
                }
            }
        } catch (error) {
            console.error("❌ Cleanup failed:", error.message);
        }
    }
}
