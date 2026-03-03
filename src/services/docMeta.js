import { readFile, writeFile } from "node:fs/promises";

/**
 * In-memory document metadata cache backed by a JSON file.
 *
 * Stores lightweight workspace name + project count per document.
 * Updated from the live Y.Doc in onStoreDocument (zero decode cost),
 * persisted to a JSON file so the cache survives server restarts.
 */
export class DocMetaCache {
  /** @param {{ filePath: string }} opts */
  constructor({ filePath }) {
    this._filePath = filePath;
    /** @type {Map<string, { workspaceName: string|null, projectCount: number }>} */
    this._cache = new Map();
    this._dirty = false;
    this._saving = false;
  }

  /** Load cache from disk. Silent on missing/corrupt file. */
  async load() {
    try {
      const raw = await readFile(this._filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, meta] of Object.entries(parsed)) {
          if (meta && typeof meta === "object") {
            this._cache.set(name, {
              workspaceName: typeof meta.workspaceName === "string" ? meta.workspaceName : null,
              projectCount: typeof meta.projectCount === "number" ? meta.projectCount : 0,
            });
          }
        }
      }
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.error("DocMetaCache: failed to load cache file:", err);
      }
    }
  }

  /** Update metadata for a document and persist to disk. */
  set(name, { workspaceName, projectCount }) {
    this._cache.set(name, {
      workspaceName: workspaceName ?? null,
      projectCount: projectCount ?? 0,
    });
    this._dirty = true;
    this._scheduleSave();
  }

  /** Get cached metadata for a single document (or null). */
  get(name) {
    return this._cache.get(name) ?? null;
  }

  /** Remove cached metadata for a document. */
  delete(name) {
    if (this._cache.delete(name)) {
      this._dirty = true;
      this._scheduleSave();
    }
  }

  // ── Persistence ──────────────────────────────────────────────

  _scheduleSave() {
    if (this._saving) return;
    this._saving = true;
    queueMicrotask(() => void this._flush());
  }

  async _flush() {
    if (!this._dirty) {
      this._saving = false;
      return;
    }
    this._dirty = false;
    try {
      const obj = Object.fromEntries(this._cache);
      await writeFile(this._filePath, JSON.stringify(obj, null, 2), "utf-8");
    } catch (err) {
      // Restore dirty flag so next set() retries the write
      this._dirty = true;
      console.error("Failed to persist document metadata cache:", err);
    } finally {
      this._saving = false;
      if (this._dirty) this._scheduleSave();
    }
  }
}
