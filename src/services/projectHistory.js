import { DatabaseSync } from "node:sqlite";
import { enableSecureDelete } from "../lib/sqlite.js";

export const DEFAULT_PROJECT_HISTORY_LIMIT = 20;

/**
 * Previous versions of projects edited through the admin API. Kept in its own
 * SQLite file (not the document DB) so the Hocuspocus schema is untouched and
 * restoring a document backup does not erase the edit history.
 */
export class ProjectHistoryStore {
  /** @param {{ dbPath: string, limit?: number }} options */
  constructor({ dbPath, limit = DEFAULT_PROJECT_HISTORY_LIMIT }) {
    this.limit = limit;
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    enableSecureDelete(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_name TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        version TEXT NOT NULL,
        title TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_versions_lookup
        ON project_versions (doc_name, project_id, id);
    `);
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }

  /**
   * Store a snapshot and prune to the newest `limit` entries for that project,
   * in one transaction.
   * @returns {number} id of the new entry
   */
  add({ docName, projectId, reason, version, project }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `INSERT INTO project_versions (doc_name, project_id, created_at, reason, version, title, json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          docName,
          projectId,
          new Date().toISOString(),
          reason,
          version,
          typeof project?.title === "string" ? project.title : null,
          JSON.stringify(project),
        );
      this.db
        .prepare(
          `DELETE FROM project_versions
           WHERE doc_name = ? AND project_id = ? AND id NOT IN (
             SELECT id FROM project_versions WHERE doc_name = ? AND project_id = ?
             ORDER BY id DESC LIMIT ?
           )`,
        )
        .run(docName, projectId, docName, projectId, this.limit);
      this.db.exec("COMMIT");
      return Number(result.lastInsertRowid);
    } catch (err) {
      if (this.db.isTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // keep original error
        }
      }
      throw err;
    }
  }

  /** Drop one entry (used when the write it was snapshotted for failed). */
  remove(id) {
    this.db.prepare("DELETE FROM project_versions WHERE id = ?").run(id);
  }

  list(docName, projectId) {
    return this.db
      .prepare(
        `SELECT id, created_at, reason, version, title FROM project_versions
         WHERE doc_name = ? AND project_id = ? ORDER BY id DESC`,
      )
      .all(docName, projectId)
      .map((row) => ({
        id: Number(row.id),
        createdAt: row.created_at,
        reason: row.reason,
        version: row.version,
        title: row.title,
      }));
  }

  get(docName, projectId, id) {
    const row = this.db
      .prepare(
        `SELECT id, created_at, reason, version, json FROM project_versions
         WHERE doc_name = ? AND project_id = ? AND id = ?`,
      )
      .get(docName, projectId, id);
    if (!row) return null;
    return {
      id: Number(row.id),
      createdAt: row.created_at,
      reason: row.reason,
      version: row.version,
      project: JSON.parse(row.json),
    };
  }
}
