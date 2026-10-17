import * as Y from "yjs";
import { withDb } from "../lib/db.js";
import { isDocTooLargeToDecode, toByteLength } from "../lib/doc.js";
import { validateProject } from "../yjs/projectSchema.js";
import { deepEqual, projectVersion, syncYMap } from "../yjs/projectSync.js";

export class ProjectEditorError extends Error {
  /** @param {number} status @param {string} message @param {object} [details] */
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const readId = (yMapOrObj) => {
  const id = yMapOrObj instanceof Y.Map ? yMapOrObj.get("id") : yMapOrObj?.id;
  if (typeof id === "string") return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
};

const getProjectsArray = (ydoc) => {
  const projects = ydoc.getMap("root").get("projects");
  return projects instanceof Y.Array ? projects : null;
};

/** Locate a project's Y.Map in the workspace doc; ids must be unique. */
const findProject = (ydoc, projectId) => {
  const projects = getProjectsArray(ydoc);
  if (!projects) return { error: new ProjectEditorError(404, "Workspace has no projects") };
  const matches = [];
  projects.forEach((item, index) => {
    if (item instanceof Y.Map && readId(item) === projectId) matches.push({ yMap: item, index });
  });
  if (matches.length === 0) return { error: new ProjectEditorError(404, `Project "${projectId}" not found`) };
  if (matches.length > 1) {
    return { error: new ProjectEditorError(409, `Project id "${projectId}" is not unique in this workspace; edit it in the app`) };
  }
  return matches[0];
};

const summarize = (yItem) => {
  const json = yItem instanceof Y.Map ? yItem.toJSON() : null;
  if (!json) return null;
  const id = readId(json);
  const item = { id, title: typeof json.title === "string" ? json.title : null };
  const description = json.info && typeof json.info.description === "string" ? json.info.description : "";
  if (description) item.description = description.replace(/\s+/g, " ").trim().slice(0, 120);
  item.tasks = Array.isArray(json.tasks) ? json.tasks.length : 0;
  item.openTasks = Array.isArray(json.tasks) ? json.tasks.filter((t) => t && !t.completed).length : 0;
  return item;
};

/**
 * Read and edit single projects inside workspace Yjs documents.
 *
 * Reads use the live in-memory document when Hocuspocus has it loaded (so
 * unsaved realtime edits are included), otherwise the stored DB copy.
 * Writes always go through a Hocuspocus direct connection: the change is one
 * Yjs transaction on the live document, broadcast to connected clients, then
 * stored immediately.
 */
export class ProjectEditor {
  constructor({ hocuspocus, dbPath, history, maxDocDecodeBytes }) {
    this.hocuspocus = hocuspocus;
    this.dbPath = dbPath;
    this.history = history;
    this.maxDocDecodeBytes = maxDocDecodeBytes;
  }

  /** @returns {Uint8Array|null} stored document bytes, or null if absent */
  readStored(docName) {
    // Briefly wait out a lock held by another process (e.g. a backup) instead
    // of failing the read. Same-process writes are synchronous, so never overlap.
    return withDb(this.dbPath, { readOnly: true, timeout: 1000 }, (db) => {
      const hasTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'")
        .get();
      if (!hasTable) return null;
      const row = db
        .prepare("SELECT data, length(data) AS size FROM documents WHERE name = ?")
        .get(docName);
      if (!row) return null;
      const size = toByteLength(row.size);
      if (isDocTooLargeToDecode(size, this.maxDocDecodeBytes)) {
        throw new ProjectEditorError(413, `Document is ${size} bytes and exceeds MAX_DOC_DECODE_BYTES (${this.maxDocDecodeBytes})`);
      }
      return row.data;
    });
  }

  documentExists(docName) {
    return this.hocuspocus.documents.has(docName) || this.readStored(docName) != null;
  }

  /** Run fn(ydoc) against the freshest readable copy of the document. */
  withReadDoc(docName, fn) {
    const live = this.hocuspocus.documents.get(docName);
    if (live) return fn(live);
    const data = this.readStored(docName);
    if (data == null) throw new ProjectEditorError(404, `Document "${docName}" not found`);
    const ydoc = new Y.Doc();
    try {
      Y.applyUpdate(ydoc, data);
      return fn(ydoc);
    } finally {
      ydoc.destroy();
    }
  }

  listProjects(docName) {
    return this.withReadDoc(docName, (ydoc) => {
      const projects = getProjectsArray(ydoc);
      if (!projects) return [];
      return projects.toArray().map(summarize).filter(Boolean);
    });
  }

  getProject(docName, projectId) {
    return this.withReadDoc(docName, (ydoc) => {
      const found = findProject(ydoc, projectId);
      if (found.error) throw found.error;
      const project = found.yMap.toJSON();
      return {
        project,
        version: projectVersion(project),
        // Baseline = itself: what is already stored is reported as warnings.
        validation: validateProject(project, { expectedId: projectId, stored: project }),
      };
    });
  }

  /** Validate a draft against the currently stored project (no write). */
  validateDraft(docName, projectId, draft) {
    let stored;
    try {
      stored = this.getProject(docName, projectId).project;
    } catch (err) {
      if (!(err instanceof ProjectEditorError) || err.status !== 404) throw err;
    }
    return validateProject(draft, { expectedId: projectId, stored });
  }

  /**
   * Replace a project with `next` atomically.
   * @param {{ docName: string, projectId: string, baseVersion: string, next: object,
   *   reason: "edit"|"patch"|"restore", allowInvalid?: boolean }} args
   */
  async saveProject({ docName, projectId, baseVersion, next, reason, allowInvalid = false }) {
    if (typeof baseVersion !== "string" || !baseVersion) {
      throw new ProjectEditorError(400, "baseVersion is required (use the version returned by GET)");
    }
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      const validation = validateProject(next, { expectedId: projectId });
      throw new ProjectEditorError(422, "Project JSON is invalid; nothing was saved", {
        errors: validation.errors,
        warnings: validation.warnings,
      });
    }
    if (readId(next) !== projectId) {
      throw new ProjectEditorError(422, "Project id cannot be changed; nothing was saved", {
        errors: [{ path: "project.id", message: `expected ${JSON.stringify(projectId)}` }],
        warnings: [],
      });
    }
    // Never let openDirectConnection create a brand-new empty document.
    if (!this.documentExists(docName)) {
      throw new ProjectEditorError(404, `Document "${docName}" not found`);
    }

    const connection = await this.hocuspocus.openDirectConnection(docName, {
      source: "admin-project-editor",
    });
    let outcome;
    try {
      // The whole check-and-write runs synchronously inside one Yjs
      // transaction, so no realtime update can interleave between the
      // version check and the write.
      await connection.transact((document) => {
        const found = findProject(document, projectId);
        if (found.error) {
          outcome = { error: found.error };
          return;
        }
        const current = found.yMap.toJSON();
        const currentVersion = projectVersion(current);
        if (currentVersion !== baseVersion) {
          outcome = {
            error: new ProjectEditorError(409, "This project was changed by someone else since you loaded it; nothing was saved. Reload to see the latest version.", {
              currentVersion,
            }),
          };
          return;
        }
        // Validate against the exact version being replaced (same transaction),
        // so issues already stored in it are tolerated while unchanged.
        const validation = validateProject(next, { expectedId: projectId, stored: current });
        if (!validation.ok && !allowInvalid) {
          outcome = {
            error: new ProjectEditorError(422, "Project JSON is invalid; nothing was saved", {
              errors: validation.errors,
              warnings: validation.warnings,
            }),
          };
          return;
        }
        const { warnings } = validation;
        if (deepEqual(current, next)) {
          outcome = { unchanged: true, version: currentVersion, historyId: null, warnings };
          return;
        }

        // Snapshot first: if this throws, nothing has been changed yet.
        const historyId = this.history.add({
          docName,
          projectId,
          reason,
          version: currentVersion,
          project: current,
        });

        let written;
        try {
          syncYMap(found.yMap, next);
          written = found.yMap.toJSON();
        } catch (err) {
          console.error("[project-editor] write failed, rolling back:", err);
          written = undefined;
        }
        if (written === undefined || !deepEqual(written, next)) {
          // Should be impossible; undo within the same transaction so clients
          // never observe a half-applied project.
          let restored = false;
          try {
            syncYMap(found.yMap, current);
            restored = deepEqual(found.yMap.toJSON(), current);
          } catch (err) {
            console.error("[project-editor] rollback failed:", err);
          }
          if (restored) {
            // Nothing changed, so the snapshot is not a real previous version.
            try {
              this.history.remove(historyId);
            } catch (err) {
              console.error("[project-editor] could not drop history entry:", err);
            }
            outcome = { error: new ProjectEditorError(500, "Write verification failed; the project was left unchanged") };
          } else {
            // Keep the snapshot so the previous version can be restored.
            outcome = {
              error: new ProjectEditorError(500, "Write failed and could not be fully rolled back; reload the project and check it. The previous version is in History.", { historyId }),
            };
          }
          return;
        }
        outcome = { unchanged: false, version: projectVersion(written), historyId, warnings };
      });
    } finally {
      // Persists the document immediately (bypasses the debounce).
      await connection.disconnect();
    }

    if (outcome?.error) throw outcome.error;
    const { warnings = [], ...result } = outcome;
    return { ...result, warnings };
  }

  async patchProject({ docName, projectId, baseVersion, patch }) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new ProjectEditorError(400, "patch must be a JSON object of top-level project fields");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "id")) {
      throw new ProjectEditorError(422, "Project id cannot be changed; nothing was saved", {
        errors: [{ path: "project.id", message: "id cannot be patched" }],
        warnings: [],
      });
    }
    const { project, version } = this.getProject(docName, projectId);
    if (version !== baseVersion) {
      throw new ProjectEditorError(409, "This project was changed by someone else since you loaded it; nothing was saved. Reload to see the latest version.", {
        currentVersion: version,
      });
    }
    const next = { ...project };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return this.saveProject({ docName, projectId, baseVersion, next, reason: "patch" });
  }

  listHistory(docName, projectId) {
    return this.history.list(docName, projectId);
  }

  getHistoryEntry(docName, projectId, historyId) {
    const entry = this.history.get(docName, projectId, historyId);
    if (!entry) throw new ProjectEditorError(404, "History entry not found");
    return entry;
  }

  async restoreProject({ docName, projectId, historyId, baseVersion }) {
    const entry = this.getHistoryEntry(docName, projectId, historyId);
    // A history entry is a state that was really stored, so it may be restored
    // even if it predates the current schema; the id must still match.
    return this.saveProject({
      docName,
      projectId,
      baseVersion,
      next: entry.project,
      reason: "restore",
      allowInvalid: true,
    });
  }
}
