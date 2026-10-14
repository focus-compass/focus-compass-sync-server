import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { enableSecureDelete } from "./sqlite.js";

/** Public prefix that makes MCP tokens recognizable (e.g. by secret scanners). */
export const MCP_TOKEN_PREFIX = "fcmcp_";
/** Characters of the full token kept in the DB and shown in the admin UI. */
export const MCP_TOKEN_DISPLAY_LENGTH = MCP_TOKEN_PREFIX.length + 6;
export const MAX_MCP_TOKEN_NAME_LENGTH = 64;

// Avoid a DB write on every MCP request: refresh last_used_at at most this often.
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS mcp_tokens_active ON mcp_tokens (revoked_at);
`;

export const hashMcpToken = (token) =>
  createHash("sha256").update(String(token), "utf8").digest("hex");

const generateToken = () => `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

/**
 * Normalize a user-supplied token name. Returns "" when the caller did not
 * provide one, or null when it is invalid.
 * @param {unknown} value
 * @returns {string|null}
 */
export const normalizeMcpTokenName = (value) => {
  if (value == null) return "";
  if (typeof value !== "string") return null;
  // Collapse whitespace and drop control characters.
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length > MAX_MCP_TOKEN_NAME_LENGTH) return null;
  return name;
};

const toPublic = (row) => ({
  id: Number(row.id),
  name: row.name,
  prefix: row.token_prefix,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at ?? null,
});

/**
 * MCP access tokens. Only SHA-256 hashes of the tokens are stored (tokens are
 * 256-bit random values, so an unsalted fast hash is sufficient); the full
 * token is returned exactly once, from `issue()`.
 */
export class McpTokenStore {
  /** @param {{ dbPath: string }} options */
  constructor({ dbPath }) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    enableSecureDelete(this.db);
    this.db.exec(SCHEMA);
    this.lastUsedWrites = new Map();
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }

  hasActive() {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM mcp_tokens WHERE revoked_at IS NULL LIMIT 1")
      .get();
    return Boolean(row);
  }

  list() {
    return this.db
      .prepare(
        `SELECT id, name, token_prefix, created_at, last_used_at
         FROM mcp_tokens WHERE revoked_at IS NULL ORDER BY id DESC`,
      )
      .all()
      .map(toPublic);
  }

  /**
   * Issue a new token. An empty name becomes "Token N", where N counts every
   * token ever issued (revoked ones included), so auto names never repeat.
   * @param {{ name?: string }} [options]
   * @returns {{ token: string, record: ReturnType<typeof toPublic> }}
   */
  issue({ name = "" } = {}) {
    const token = generateToken();
    const createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let finalName = name;
      if (!finalName) {
        const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM mcp_tokens").get();
        finalName = `Token ${Number(n) + 1}`;
      }
      const result = this.db
        .prepare(
          `INSERT INTO mcp_tokens (name, token_hash, token_prefix, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(finalName, hashMcpToken(token), token.slice(0, MCP_TOKEN_DISPLAY_LENGTH), createdAt);
      this.db.exec("COMMIT");
      const row = this.db
        .prepare(
          "SELECT id, name, token_prefix, created_at, last_used_at FROM mcp_tokens WHERE id = ?",
        )
        .get(result.lastInsertRowid);
      return { token, record: toPublic(row) };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Revoke an active token. Revoked rows are kept (hash only) so the
   * "Token N" counter stays monotonic.
   * @returns {boolean} true when an active token was revoked
   */
  revoke(id) {
    const result = this.db
      .prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id);
    this.lastUsedWrites.delete(Number(id));
    return Number(result.changes) > 0;
  }

  /**
   * Check a presented bearer token. Lookup is by hash, so the raw token is
   * never compared or stored. Records last use on success (throttled).
   * @returns {boolean}
   */
  verify(token) {
    if (typeof token !== "string" || !token.startsWith(MCP_TOKEN_PREFIX)) return false;
    const row = this.db
      .prepare("SELECT id FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hashMcpToken(token));
    if (!row) return false;
    this.touch(Number(row.id));
    return true;
  }

  touch(id) {
    const now = Date.now();
    const last = this.lastUsedWrites.get(id) ?? 0;
    if (now - last < LAST_USED_WRITE_INTERVAL_MS) return;
    this.lastUsedWrites.set(id, now);
    try {
      this.db
        .prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(new Date(now).toISOString(), id);
    } catch (err) {
      console.warn("Failed to record MCP token use:", err?.message || err);
    }
  }
}
