import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const BACKUP_RE = /^backup-[0-9A-Za-z._-]+\.sqlite$/;

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
     * Safe to call frequently — skips integrity check for performance.
     * Reads intervalMinutes from settings (default 30).
     */
    async tryBackup() {
        await this.ready;

        if (this.isBackingUp || this.isRestoring) return;

        const settings = await this._readSettings();
        const raw = Number(settings?.intervalMinutes);
        const intervalMinutes = Number.isFinite(raw) && raw > 0 ? raw : 30;

        const now = Date.now();
        const intervalMs = intervalMinutes * 60 * 1000;

        if (now - this.lastAutoBackupAttemptTime < intervalMs) return;

        this.lastAutoBackupAttemptTime = now;

        try {
            await this._createBackup("backup", { skipIntegrityCheck: true, settings });
            this._markBackupSuccess();
        } catch (error) {
            this._markAutoBackupFailure(error);
        }
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
     * Creates an atomic, consistent backup using SQLite VACUUM INTO.
     * Produces a single self-contained .sqlite file (no WAL/SHM/journal sidecars).
     *
     * @param {string} [prefix="backup"] - Filename prefix
     * @param {Object} [options]
     * @param {boolean} [options.skipIntegrityCheck=false] - Skip PRAGMA integrity_check
     *   (for automatic interval backups where speed matters)
     * @param {boolean} [options.skipCleanup=false] - Skip old-backup cleanup
     *   (for pre-restore snapshots where we must not delete the source backup)
     * @param {Object|null} [options.settings=null] - Pre-read settings to avoid re-reading the file
     * @returns {Promise<string>} backup filename
     */
    async _createBackup(prefix = "backup", { skipIntegrityCheck = false, skipCleanup = false, settings = null } = {}) {
        this.isBackingUp = true;
        let backupFile = null;
        let backupPath = null;
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
            backupFile = `${prefix}-${timestamp}.sqlite`;
            backupPath = join(this.backupDir, backupFile);
            tempBackupPath = join(this.backupDir, `${backupFile}.tmp`);

            // VACUUM INTO creates an atomic, fully consistent copy of the database
            // as a single file — no WAL, SHM, or journal sidecars needed.
            const db = new DatabaseSync(this.dbPath, { readOnly: true });
            try {
                db.exec(`VACUUM INTO '${tempBackupPath.replace(/'/g, "''")}'`);
            } finally {
                db.close();
            }

            const backupStats = await stat(tempBackupPath).catch(() => null);
            if (!backupStats?.isFile?.() || backupStats.size <= 0) {
                throw new Error("Backup file is empty");
            }

            if (!skipIntegrityCheck) {
                await this._verifyIntegrity(tempBackupPath);
            }

            await rename(tempBackupPath, backupPath);
            tempBackupPath = null;

            this.lastBackupTime = Date.now();

            if (!skipCleanup) {
                await this._cleanOldBackups(settings);
            }

            return backupFile;
        } catch (error) {
            if (tempBackupPath) {
                await unlink(tempBackupPath).catch(() => {});
            }
            if (backupPath) {
                await this._deleteBackup(backupPath).catch(() => {});
            }
            console.error("❌ Backup failed:", error.message);
            throw error;
        } finally {
            this.isBackingUp = false;
        }
    }

    /**
     * Verifies a SQLite file passes PRAGMA integrity_check.
     * @param {string} filePath - Absolute path to the .sqlite file
     * @param {boolean} [deleteOnFailure=true] - Delete the file if the check fails
     *   (useful for newly created backups; set to false when verifying existing files)
     */
    async _verifyIntegrity(filePath, deleteOnFailure = true) {
        const db = new DatabaseSync(filePath, { readOnly: true });
        try {
            const row = db.prepare("PRAGMA integrity_check").get();
            const result = row?.integrity_check ?? row?.["integrity_check"];
            if (result !== "ok") {
                db.close();
                if (deleteOnFailure) {
                    await unlink(filePath).catch(() => {});
                }
                throw new Error(`Backup integrity check failed: ${result}`);
            }
        } finally {
            try { db.close(); } catch { /* already closed */ }
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

    async _deleteBackup(filePath) {
        await unlink(filePath);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
            try {
                await unlink(`${filePath}${suffix}`);
            } catch (error) {
                if (error?.code === "ENOENT") continue;
            }
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

        // 4. Replace current DB: rename old → .old, copy backup → DB_PATH
        const oldDbPath = `${this.dbPath}.old`;
        try {
            // Move current DB out of the way
            const hasDb = await stat(this.dbPath).catch(() => null);
            if (hasDb) {
                await rename(this.dbPath, oldDbPath);
            }

            // Use VACUUM INTO from the backup to create a clean copy at DB_PATH.
            // This ensures the restored file is a self-contained, consistent DB.
            const db = new DatabaseSync(backupPath, { readOnly: true });
            try {
                db.exec(`VACUUM INTO '${this.dbPath.replace(/'/g, "''")}'`);
            } finally {
                db.close();
            }

            // Remove stale sidecars from the live DB path
            await BackupService._removeSidecars(this.dbPath);

            // Clean up .old file (best-effort)
            await unlink(oldDbPath).catch(() => {});
        } catch (error) {
            // Attempt to roll back: restore the .old file if it exists
            try {
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
            try {
                await unlink(`${dbPath}${suffix}`);
            } catch (error) {
                if (error?.code === "ENOENT") continue;
            }
        }
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
                        await this._deleteBackup(entry.filePath);
                    }
                }
            } else if (mode === "count") {
                const maxCount = Math.floor(effectiveValue);
                while (entries.length > maxCount) {
                    const oldest = entries.shift();
                    await this._deleteBackup(oldest.filePath);
                }
            } else if (mode === "size") {
                let totalBytes = entries.reduce((sum, e) => sum + e.totalSize, 0);
                // Always keep at least 1 backup even if it exceeds the size limit
                while (totalBytes > effectiveValue && entries.length > 1) {
                    const oldest = entries.shift();
                    await this._deleteBackup(oldest.filePath);
                    totalBytes -= oldest.totalSize;
                }
            }
        } catch (error) {
            console.error("❌ Cleanup failed:", error.message);
        }
    }
}
