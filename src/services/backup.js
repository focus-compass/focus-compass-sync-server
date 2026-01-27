import { mkdir, readdir, stat, unlink, copyFile } from "node:fs/promises";
import { join } from "node:path";

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
     */
    constructor(config) {
        this.dbPath = config.dbPath;
        this.backupDir = config.backupDir ?? "./backups";
        this.intervalMinutes = config.intervalMinutes ?? 60;
        this.retentionDays = config.retentionDays ?? 7;

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

            console.log(`✅ Backup: ${backupPath}`);

            this.lastBackupTime = now;
            await this._cleanOldBackups();
        } catch (error) {
            console.error("❌ Backup failed:", error.message);
        } finally {
            this.isBackingUp = false;
        }
    }

    async _cleanOldBackups() {
        try {
            const files = await readdir(this.backupDir);
            const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
            const now = Date.now();

            for (const file of files) {
                if (!file.endsWith(".sqlite")) continue;

                const filePath = join(this.backupDir, file);
                const stats = await stat(filePath);

                if (now - stats.mtimeMs > retentionMs) {
                    await unlink(filePath);

                    // Remove possible WAL/SHM sidecars for this backup
                    const sidecars = [`${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`];
                    for (const sidecarPath of sidecars) {
                        try {
                            await unlink(sidecarPath);
                        } catch (error) {
                            if (error?.code === "ENOENT") continue;
                        }
                    }

                    console.log(`🗑️ Deleted old backup: ${file}`);
                }
            }
        } catch (error) {
            console.error("❌ Cleanup failed:", error.message);
        }
    }
}
