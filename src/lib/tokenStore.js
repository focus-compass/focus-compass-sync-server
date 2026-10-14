import { createHash, randomBytes } from "node:crypto";
import { readJsonOrNull } from "./fs.js";
import { writePrivateJsonFile } from "./privateFiles.js";

// Multi-token store. Tokens are random 32-char base64url secrets; only their
// SHA-256 hash is persisted (high-entropy secrets, so a fast hash is enough).
// The plaintext is returned exactly once, from create().

export const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
export const MAX_TOKEN_NAME_LENGTH = 64;
const PREFIX_LENGTH = 6;
const LAST_USED_PERSIST_INTERVAL_MS = 60_000;
export const ENV_TOKEN_ID = "env";

export const generateTokenSecret = () => randomBytes(24).toString("base64url");
export const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");
const generateId = () => randomBytes(8).toString("hex");

export const normalizeTokenName = (raw) => {
  if (raw == null) return "";
  return String(raw).replace(/\p{Cc}/gu, "").replace(/\s+/g, " ").trim();
};

const publicView = (t) => ({
  id: t.id,
  name: t.name,
  prefix: t.prefix,
  createdAt: t.createdAt,
  lastUsedAt: t.lastUsedAt || null,
  envManaged: Boolean(t.envManaged),
});

export class TokenStore {
  constructor({ filePath, envToken = "", now = () => new Date() }) {
    this.filePath = filePath;
    this.now = now;
    this.tokens = []; // persisted, non-revoked
    this.byHash = new Map();
    this.envEntry = null;
    this.lastPersistedUse = new Map();
    this.counter = 0;
    this.writeChain = Promise.resolve();
    if (envToken) {
      this.envEntry = {
        id: ENV_TOKEN_ID,
        name: "Environment (ACCESS_TOKEN)",
        hash: hashToken(envToken),
        prefix: envToken.slice(0, PREFIX_LENGTH),
        createdAt: null,
        lastUsedAt: null,
        envManaged: true,
      };
    }
  }

  async load() {
    const data = await readJsonOrNull(this.filePath);
    const list = Array.isArray(data?.tokens) ? data.tokens : [];
    this.tokens = list.filter(
      (t) => t && typeof t.id === "string" && typeof t.hash === "string" && /^[0-9a-f]{64}$/.test(t.hash),
    );
    this.counter = Number.isInteger(data?.counter) ? data.counter : this.tokens.length;
    this.reindex();
    return this;
  }

  reindex() {
    this.byHash = new Map(this.tokens.map((t) => [t.hash, t]));
    if (this.envEntry) this.byHash.set(this.envEntry.hash, this.envEntry);
  }

  get initialized() {
    return this.byHash.size > 0;
  }

  get hasFileTokens() {
    return this.tokens.length > 0;
  }

  list() {
    const items = this.tokens.map(publicView);
    if (this.envEntry) items.unshift(publicView(this.envEntry));
    return items;
  }

  persist() {
    const payload = { version: 2, counter: this.counter, tokens: this.tokens };
    const run = () => writePrivateJsonFile(this.filePath, payload);
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  // Returns the matching token entry (without secrets) or null.
  verify(candidate) {
    if (typeof candidate !== "string" || !candidate || !TOKEN_RE.test(candidate)) return null;
    const entry = this.byHash.get(hashToken(candidate));
    if (!entry) return null;
    this.touch(entry);
    return entry;
  }

  touch(entry) {
    const nowDate = this.now();
    entry.lastUsedAt = nowDate.toISOString();
    if (entry.envManaged) return;
    const last = this.lastPersistedUse.get(entry.id) || 0;
    if (nowDate.getTime() - last < LAST_USED_PERSIST_INTERVAL_MS) return;
    this.lastPersistedUse.set(entry.id, nowDate.getTime());
    this.persist().catch((err) => console.error("Token lastUsed persist error:", err?.message || err));
  }

  defaultName() {
    return `Token ${this.counter + 1}`;
  }

  async create({ name } = {}) {
    let cleanName = normalizeTokenName(name);
    if (cleanName.length > MAX_TOKEN_NAME_LENGTH) {
      throw Object.assign(new Error("Name too long"), { code: "EINVAL" });
    }
    if (!cleanName) cleanName = this.defaultName();
    const secret = generateTokenSecret();
    const entry = {
      id: generateId(),
      name: cleanName,
      hash: hashToken(secret),
      prefix: secret.slice(0, PREFIX_LENGTH),
      createdAt: this.now().toISOString(),
      lastUsedAt: null,
    };
    this.tokens.push(entry);
    this.counter += 1;
    this.reindex();
    try {
      await this.persist();
    } catch (err) {
      this.tokens = this.tokens.filter((t) => t !== entry);
      this.counter -= 1;
      this.reindex();
      throw err;
    }
    return { token: secret, item: publicView(entry) };
  }

  async revoke(id) {
    const entry = this.tokens.find((t) => t.id === id);
    if (!entry) return false;
    const prev = this.tokens;
    this.tokens = this.tokens.filter((t) => t !== entry);
    this.reindex();
    try {
      await this.persist();
    } catch (err) {
      this.tokens = prev;
      this.reindex();
      throw err;
    }
    return true;
  }
}
