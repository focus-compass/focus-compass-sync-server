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
        this.backupDir = config.backupDir || "./backups";
        this.intervalMinutes = config.intervalMinutes || 10;
        this.retentionDays = config.retentionDays || 7;

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
        const now = Date.now();
        const intervalMs = this.intervalMinutes * 60 * 1000;

        // Skip if already backing up or interval not passed
        if (this.isBackingUp || now - this.lastBackupTime < intervalMs) {
            return;
        }

        this.isBackingUp = true;

        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupPath = join(this.backupDir, `backup-${timestamp}.sqlite`);

            // Simple file copy - SQLite handles concurrent reads safely
            await copyFile(this.dbPath, backupPath);
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
                    console.log(`🗑️ Deleted old backup: ${file}`);
                }
            }
        } catch (error) {
            console.error("❌ Cleanup failed:", error.message);
        }
    }
}
