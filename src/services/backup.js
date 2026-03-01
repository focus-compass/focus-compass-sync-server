import { mkdir, readdir, readFile, stat, unlink, copyFile } from "node:fs/promises";
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
     * @param {number} [config.intervalMinutes=60] - Minimum interval between backups in minutes
     * @param {number} [config.retentionDays=7] - Days to keep backups
     * @param {string|null} [config.settingsFilePath=null] - Path to backup-settings.json
     */
    constructor(config) {
        this.dbPath = config.dbPath;
        this.backupDir = config.backupDir ?? "./backups";
        this.intervalMinutes = config.intervalMinutes ?? 60;
        this.retentionDays = config.retentionDays ?? 7;
        this.settingsFilePath = config.settingsFilePath ?? null;

        this.lastBackupTime = 0;
        this.isBackingUp = false;

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
     */
    async tryBackup() {
        await this.ready;

        // Allow disabling backups via intervalMinutes=0
        if (this.intervalMinutes <= 0) return;

        const now = Date.now();
        const intervalMs = this.intervalMinutes * 60 * 1000;

        // Skip if already backing up or interval not passed
        if (this.isBackingUp || now - this.lastBackupTime < intervalMs) {
            return;
        }

        this.isBackingUp = true;

        try {
            // Skip if database doesn't exist yet
            try {
                await stat(this.dbPath);
            } catch (error) {
                if (error?.code === "ENOENT") return;
                throw error;
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupPath = join(this.backupDir, `backup-${timestamp}.sqlite`);

            // Copy main DB file (best-effort). If SQLite runs in WAL mode,
            // also copy sidecar files to keep a consistent snapshot.
            await copyFile(this.dbPath, backupPath);

            const sidecars = [
                { src: `${this.dbPath}-wal`, dest: `${backupPath}-wal` },
                { src: `${this.dbPath}-shm`, dest: `${backupPath}-shm` },
                { src: `${this.dbPath}-journal`, dest: `${backupPath}-journal` },
            ];

            for (const sidecar of sidecars) {
                try {
                    await copyFile(sidecar.src, sidecar.dest);
                } catch (error) {
                    if (error?.code === "ENOENT") continue;
                    // Ignore best-effort sidecar copy errors
                }
            }

            this.lastBackupTime = now;
            await this._cleanOldBackups();
        } catch (error) {
            console.error("❌ Backup failed:", error.message);
        } finally {
            this.isBackingUp = false;
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

    async _cleanOldBackups() {
        try {
            const settings = await this._readSettings();
            const limitMode = settings?.mode || "none";
            const limitValue = Number(settings?.value);
            const hasLimit = limitMode !== "none" && Number.isFinite(limitValue) && limitValue > 0;

            // Build a full list of backups sorted oldest-first
            let entries = await this._listBackupEntries();

            // Phase 1: retention-days cleanup (skip entries that a count/size limit will keep)
            const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
            const now = Date.now();

            if (retentionMs > 0) {
                const toDelete = [];
                for (const entry of entries) {
                    if (now - entry.mtimeMs > retentionMs) {
                        toDelete.push(entry);
                    }
                }

                // When a count limit is active, never delete more than would
                // bring us below the allowed count via retention alone.
                if (hasLimit && limitMode === "count") {
                    while (entries.length - toDelete.length < limitValue && toDelete.length > 0) {
                        toDelete.pop(); // spare the newest of the expired batch
                    }
                }

                for (const entry of toDelete) {
                    await this._deleteBackup(entry.filePath);
                }

                // Rebuild entries list after retention cleanup
                if (toDelete.length > 0) {
                    const deletedPaths = new Set(toDelete.map((e) => e.filePath));
                    entries = entries.filter((e) => !deletedPaths.has(e.filePath));
                }
            }

            // Phase 2: enforce user-configured limits (trim oldest first)
            if (!hasLimit) return;

            if (limitMode === "count") {
                while (entries.length > limitValue) {
                    const oldest = entries.shift();
                    await this._deleteBackup(oldest.filePath);
                }
            } else if (limitMode === "size") {
                let totalBytes = entries.reduce((sum, e) => sum + e.totalSize, 0);
                // Always keep at least 1 backup even if it exceeds the size limit
                while (totalBytes > limitValue && entries.length > 1) {
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
