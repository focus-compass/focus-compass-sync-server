import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { hashMcpToken } from "../src/lib/mcpTokens.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MASTER = "master-token-for-mcp-tests_0123456789";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getFreePort = async () => {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
};

const startServer = async (dataDir, extraEnv = {}) => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      ACCESS_TOKEN: MASTER,
      DB_PATH: join(dataDir, "db.sqlite"),
      IMAGES_DIR: join(dataDir, "images"),
      BACKUP_DIR: join(dataDir, "backups"),
      AUTH_FILE_PATH: join(dataDir, "auth.json"),
      MCP_TOKENS_DB_PATH: join(dataDir, "mcp-tokens.sqlite"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited:\n${logs}`);
    const res = await fetch(`${url}/health`).catch(() => null);
    if (res?.ok) break;
    if (Date.now() > deadline) throw new Error(`server not healthy:\n${logs}`);
    await delay(50);
  }
  return {
    url,
    logs: () => logs,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await closed;
    },
  };
};

const api = async (server, path, { method = "GET", token = MASTER, body } = {}) => {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const mcpList = (server, token) =>
  fetch(`${server.url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

test("MCP tokens: issue, list, use, revoke", async (t) => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "fc-mcp-tokens-"));
  // A legacy single-token file must be ignored (breaking change, no migration).
  await writeFile(join(dataDir, "mcp-auth.json"), JSON.stringify({ token: "legacyTokenValue123" }));
  let server = await startServer(dataDir);
  t.after(async () => {
    await server?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  await t.test("starts disabled, legacy token is not accepted", async () => {
    assert.match(server.logs(), /Legacy MCP token file .*mcp-auth\.json is ignored/);
    const status = await api(server, "/api/mcp/status", { token: "" });
    assert.deepEqual(status.body, { enabled: false });
    const res = await mcpList(server, "legacyTokenValue123");
    assert.equal(res.status, 404);
  });

  await t.test("admin endpoints require the master token", async () => {
    assert.equal((await api(server, "/api/mcp/tokens", { token: "" })).status, 401);
    assert.equal((await api(server, "/api/mcp/tokens", { token: "wrong" })).status, 401);
    assert.equal((await api(server, "/api/mcp/tokens", { method: "POST", token: "", body: {} })).status, 401);
    assert.equal((await api(server, "/api/mcp/tokens/1", { method: "DELETE", token: "" })).status, 401);
  });

  let first;
  let second;
  let third;

  await t.test("issues tokens with auto and custom names", async () => {
    first = await api(server, "/api/mcp/tokens", { method: "POST", body: {} });
    assert.equal(first.status, 201);
    assert.match(first.body.token, /^mcp_focus_[A-Za-z0-9_-]{43}$/);
    assert.equal(first.body.tokenInfo.name, "Token 1");
    assert.equal(first.body.tokenInfo.prefix, first.body.token.slice(0, 16));
    assert.equal(first.body.tokenInfo.lastUsedAt, null);

    second = await api(server, "/api/mcp/tokens", { method: "POST", body: { name: "  Claude   Code  " } });
    assert.equal(second.status, 201);
    assert.equal(second.body.tokenInfo.name, "Claude Code");

    third = await api(server, "/api/mcp/tokens", { method: "POST", body: { name: "" } });
    assert.equal(third.body.tokenInfo.name, "Token 3");
    assert.notEqual(first.body.token, third.body.token);
  });

  await t.test("name edge cases", async () => {
    const max = await api(server, "/api/mcp/tokens", { method: "POST", body: { name: "y".repeat(64) } });
    assert.equal(max.status, 201);
    assert.equal(max.body.tokenInfo.name, "y".repeat(64));
    const blank = await api(server, "/api/mcp/tokens", { method: "POST", body: { name: " \t\n " } });
    assert.equal(blank.body.tokenInfo.name, "Token 5");
    const ctrl = await api(server, "/api/mcp/tokens", { method: "POST", body: { name: "a\u0000b\nc" } });
    assert.equal(ctrl.body.tokenInfo.name, "a b c");
    for (const x of [max, blank, ctrl]) {
      assert.equal((await api(server, `/api/mcp/tokens/${x.body.tokenInfo.id}`, { method: "DELETE" })).status, 200);
    }
  });

  await t.test("wrong methods get 405 with Allow", async () => {
    const cases = [
      ["PUT", "/api/mcp/tokens", "GET, POST"],
      ["POST", "/api/mcp/status", "GET"],
      ["GET", "/api/mcp/tokens/1", "DELETE"],
    ];
    for (const [method, path, allow] of cases) {
      const res = await fetch(`${server.url}${path}`, { method, headers: { Authorization: `Bearer ${MASTER}` } });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get("allow"), allow);
    }
  });

  await t.test("rejects invalid names", async () => {
    const long = await api(server, "/api/mcp/tokens", { method: "POST", body: { name: "x".repeat(65) } });
    assert.equal(long.status, 400);
    const wrongType = await api(server, "/api/mcp/tokens", { method: "POST", body: { name: 42 } });
    assert.equal(wrongType.status, 400);
  });

  await t.test("list never exposes the full token", async () => {
    const list = await api(server, "/api/mcp/tokens");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.tokens.map((x) => x.name), ["Token 3", "Claude Code", "Token 1"]);
    const raw = JSON.stringify(list.body);
    for (const issued of [first, second, third]) assert.ok(!raw.includes(issued.body.token));
    assert.deepEqual(
      Object.keys(list.body.tokens[0]).sort(),
      ["createdAt", "id", "lastUsedAt", "name", "prefix"],
    );
    assert.deepEqual((await api(server, "/api/mcp/status", { token: "" })).body, { enabled: true });
  });

  await t.test("database stores only hashes", async () => {
    const db = new DatabaseSync(join(dataDir, "mcp-tokens.sqlite"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT * FROM mcp_tokens WHERE revoked_at IS NULL").all();
      assert.equal(rows.length, 3);
      const dump = JSON.stringify(rows);
      for (const issued of [first, second, third]) {
        assert.ok(!dump.includes(issued.body.token));
        assert.ok(rows.some((r) => r.token_hash === hashMcpToken(issued.body.token)));
      }
    } finally {
      db.close();
    }
    if (process.platform !== "win32") {
      const mode = (await stat(join(dataDir, "mcp-tokens.sqlite"))).mode & 0o777;
      assert.equal(mode, 0o600);
    }
    // No WAL: no side files holding token data outside the 0600 main file.
    for (const suffix of ["-wal", "-shm"]) {
      await assert.rejects(access(join(dataDir, `mcp-tokens.sqlite${suffix}`)));
    }
  });

  await t.test("/mcp accepts any active token and rejects others", async () => {
    for (const issued of [first, second, third]) {
      const res = await mcpList(server, issued.body.token);
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.ok(Array.isArray(payload.result.tools));
    }
    assert.equal((await mcpList(server, MASTER)).status, 401);
    assert.equal((await mcpList(server, "mcp_focus_nope")).status, 401);

    const list = await api(server, "/api/mcp/tokens");
    for (const x of list.body.tokens) assert.ok(x.lastUsedAt, `${x.name} has lastUsedAt`);
  });

  await t.test("revoke cuts off only that token", async () => {
    const id = second.body.tokenInfo.id;
    assert.equal((await api(server, `/api/mcp/tokens/${id}`, { method: "DELETE" })).status, 200);
    assert.equal((await api(server, `/api/mcp/tokens/${id}`, { method: "DELETE" })).status, 404);
    assert.equal((await api(server, "/api/mcp/tokens/999", { method: "DELETE" })).status, 404);
    for (const bad of ["abc", "0", "01", "-1", "1.5", "9007199254740993", "1234567890"]) {
      assert.equal((await api(server, `/api/mcp/tokens/${bad}`, { method: "DELETE" })).status, 404, bad);
    }
    assert.equal((await mcpList(server, second.body.token)).status, 401);
    assert.equal((await mcpList(server, first.body.token)).status, 200);
    const list = await api(server, "/api/mcp/tokens");
    assert.deepEqual(list.body.tokens.map((x) => x.name), ["Token 3", "Token 1"]);
  });

  await t.test("auto names keep counting after revoke", async () => {
    const next = await api(server, "/api/mcp/tokens", { method: "POST", body: {} });
    assert.equal(next.body.tokenInfo.name, "Token 7");
    await api(server, `/api/mcp/tokens/${next.body.tokenInfo.id}`, { method: "DELETE" });
  });

  await t.test("tokens survive restart; MCP_TOKEN env is ignored", async () => {
    await server.stop();
    server = await startServer(dataDir, { MCP_TOKEN: "envTokenValue123" });
    assert.match(server.logs(), /MCP_TOKEN is no longer supported/);
    assert.equal((await mcpList(server, "envTokenValue123")).status, 401);
    assert.equal((await mcpList(server, first.body.token)).status, 200);
    assert.equal((await mcpList(server, second.body.token)).status, 401);
  });

  await t.test("revoking the last token disables MCP", async () => {
    for (const issued of [first, third]) {
      await api(server, `/api/mcp/tokens/${issued.body.tokenInfo.id}`, { method: "DELETE" });
    }
    assert.deepEqual((await api(server, "/api/mcp/status", { token: "" })).body, { enabled: false });
    assert.equal((await mcpList(server, first.body.token)).status, 404);
  });

  await t.test("legacy single-token endpoints are gone", async () => {
    for (const path of ["/api/mcp/enable", "/api/mcp/rotate", "/api/mcp/disable"]) {
      const res = await api(server, path, { method: "POST" });
      assert.equal(res.status, 404, path);
    }
  });
});

test("MCP token DB must not be the document DB", async () => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "fc-mcp-same-"));
  try {
    await assert.rejects(
      startServer(dataDir, { MCP_TOKENS_DB_PATH: join(dataDir, "db.sqlite") }),
      /MCP_TOKENS_DB_PATH must not point at DB_PATH/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
