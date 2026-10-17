import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { canonicalJson, projectVersion, toYjs } from "../src/yjs/projectSync.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MASTER = "master-token-for-project-editor-tests_0123456789";
const DOC = "workspace-under-test";
const HISTORY_LIMIT = 3;
const BODY_LIMIT = 1024 * 1024;
const presets = JSON.parse(
  await readFile(join(REPO_ROOT, "tests", "fixtures", "app-projects", "presets.json"), "utf8"),
);
const clone = (v) => JSON.parse(JSON.stringify(v));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check, what, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
};

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
      PROJECT_HISTORY_LIMIT: String(HISTORY_LIMIT),
      PROJECT_MAX_BODY_BYTES: String(BODY_LIMIT),
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
    wsUrl: `ws://127.0.0.1:${port}`,
    dbPath: join(dataDir, "db.sqlite"),
    logs: () => logs,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await closed;
    },
  };
};

const request = async (server, path, { method = "GET", token = MASTER, body, rawBody } = {}) => {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined || rawBody !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers,
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
};

const connect = (server, docName = DOC) => new Promise((resolve, reject) => {
  const doc = new Y.Doc();
  const timer = setTimeout(() => reject(new Error("provider did not sync")), 10_000);
  const provider = new HocuspocusProvider({
    url: server.wsUrl,
    name: docName,
    token: MASTER,
    document: doc,
    delay: 10,
    minDelay: 10,
    maxDelay: 10,
    maxAttempts: 2,
    jitter: false,
    onSynced: () => {
      clearTimeout(timer);
      resolve({ doc, provider });
    },
  });
});

const disconnect = (client) => {
  try { client.provider.configuration.websocketProvider.setConfiguration({ autoConnect: false }); } catch { /* closed */ }
  try { client.provider.destroy(); } catch { /* closed */ }
  try { client.doc.destroy(); } catch { /* closed */ }
};

const clientProject = (client, id) =>
  client.doc.getMap("root").get("projects")?.toJSON().find((p) => p.id === id);

const storedProjects = (dbPath, docName = DOC) => {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    const row = db.prepare("SELECT data FROM documents WHERE name = ?").get(docName);
    if (!row) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.data));
    return doc.getMap("root").get("projects")?.toJSON() ?? null;
  } finally {
    db.close();
  }
};

const storedBytes = (dbPath, docName = DOC) => {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    const row = db.prepare("SELECT data FROM documents WHERE name = ?").get(docName);
    return row ? Buffer.from(row.data).toString("base64") : null;
  } finally {
    db.close();
  }
};

const documentNames = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare("SELECT name FROM documents ORDER BY name").all().map((r) => r.name);
  } finally {
    db.close();
  }
};

const projectPath = (id, suffix = "") =>
  `/api/admin/documents/${encodeURIComponent(DOC)}/projects/${encodeURIComponent(id)}${suffix}`;

let dataDir;
let server;
let seedClient;
const [P1, P2, P3] = presets.slice(0, 3).map(clone);

before(async () => {
  dataDir = await mkdtemp(join(os.tmpdir(), "fc-project-editor-"));
  server = await startServer(dataDir);
  // Seed the workspace the way the app does: root.projects is a Y.Array of Y.Maps.
  seedClient = await connect(server);
  seedClient.doc.transact(() => {
    const root = seedClient.doc.getMap("root");
    const projects = new Y.Array();
    root.set("projects", projects);
    projects.push([P1, P2, P3].map((p) => toYjs(p)));
    root.set("texts", new Y.Array());
  });
  await waitFor(async () => {
    const res = await request(server, `/api/admin/documents/${DOC}/projects`);
    return res.status === 200 && res.body.projects.length === 3;
  }, "seeded projects");
  await waitFor(() => storedProjects(server.dbPath)?.length === 3, "seed persisted");
});

after(async () => {
  if (seedClient) disconnect(seedClient);
  await server?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const getProject = async (id) => {
  const res = await request(server, projectPath(id));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

test("every project endpoint requires the master token", async () => {
  const id = encodeURIComponent(P1.id);
  const base = `/api/admin/documents/${DOC}/projects`;
  const calls = [
    ["GET", base],
    ["GET", `${base}/${id}`],
    ["PUT", `${base}/${id}`, { baseVersion: "x", project: P1 }],
    ["PATCH", `${base}/${id}`, { baseVersion: "x", patch: { title: "x" } }],
    ["POST", `${base}/${id}/validate`, { project: P1 }],
    ["GET", `${base}/${id}/history`],
    ["GET", `${base}/${id}/history/1`],
    ["POST", `${base}/${id}/history/1/restore`, { baseVersion: "x" }],
  ];
  const before = storedBytes(server.dbPath);
  for (const token of [null, "wrong-token", "mcp_focus_notamastertoken"]) {
    for (const [method, path, body] of calls) {
      const res = await request(server, path, { method, token, body });
      assert.equal(res.status, 401, `${method} ${path} with ${token}`);
    }
  }
  assert.equal(storedBytes(server.dbPath), before);
  assert.equal(clientProject(seedClient, P1.id).title, P1.title);
});

test("lists projects with summaries and returns one project with its version", async () => {
  const res = await request(server, `/api/admin/documents/${DOC}/projects`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.projects.map((p) => p.id), [P1.id, P2.id, P3.id]);
  assert.equal(res.body.projects[0].title, P1.title);
  assert.equal(res.body.projects[0].tasks, P1.tasks.length);

  const one = await getProject(P2.id);
  assert.equal(canonicalJson(one.project), canonicalJson(P2));
  assert.equal(one.version, projectVersion(P2));
  assert.equal(one.validation.ok, true);
});

test("unknown document and project are 404 and nothing is created", async () => {
  const names = documentNames(server.dbPath);
  assert.equal((await request(server, "/api/admin/documents/nope/projects")).status, 404);
  assert.equal((await request(server, "/api/admin/documents/nope/projects/x")).status, 404);
  const put = await request(server, "/api/admin/documents/nope/projects/x", {
    method: "PUT",
    body: { baseVersion: "0".repeat(32), project: { ...clone(P1), id: "x" } },
  });
  assert.equal(put.status, 404);
  assert.equal((await request(server, projectPath("missing"))).status, 404);
  await delay(300);
  assert.deepEqual(documentNames(server.dbPath), names);
});

test("wrong methods get 405 with Allow", async () => {
  const res = await request(server, projectPath(P1.id), { method: "DELETE" });
  assert.equal(res.status, 405);
  assert.match(res.headers.get("allow"), /PUT/);
});

test("validate endpoint reports errors with paths and saves nothing", async () => {
  const bad = clone(P1);
  bad.extra = 1;
  bad.tasks[0].completed = "no";
  const res = await request(server, projectPath(P1.id, "/validate"), { method: "POST", body: { project: bad } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.deepEqual(res.body.errors.map((e) => e.path).sort(), ["project.extra", "project.tasks[0].completed"]);
});

test("invalid saves are rejected with clear errors and change nothing", async () => {
  const { version } = await getProject(P1.id);
  const bytesBefore = storedBytes(server.dbPath);
  const historyBefore = (await request(server, projectPath(P1.id, "/history"))).body.history.length;

  const unknown = clone(P1); unknown.colour = "red";
  const wrongType = clone(P1); wrongType.position = { x: "1", y: 2 };
  const transient = clone(P1); transient.isNew = true;
  const missing = clone(P1); delete missing.tasks;
  const idChange = clone(P1); idChange.id = "hijack";
  const dupTask = clone(P1); dupTask.tasks.push(clone(dupTask.tasks[0]));

  for (const [label, project, field] of [
    ["unknown", unknown, "project.colour"],
    ["wrong type", wrongType, "project.position.x"],
    ["transient", transient, "project.isNew"],
    ["missing", missing, "project.tasks"],
    ["id change", idChange, "project.id"],
    ["duplicate id", dupTask, `project.tasks[${P1.tasks.length}].id`],
  ]) {
    const res = await request(server, projectPath(P1.id), { method: "PUT", body: { baseVersion: version, project } });
    assert.equal(res.status, 422, label);
    assert.match(res.body.error, /nothing was saved/i, label);
    assert.ok(res.body.errors.some((e) => e.path === field), `${label}: ${JSON.stringify(res.body.errors)}`);
  }

  // Malformed bodies.
  for (const rawBody of ["{not json", "[]", "null", JSON.stringify({ baseVersion: version })]) {
    const res = await request(server, projectPath(P1.id), { method: "PUT", rawBody });
    assert.equal(res.status, 400, rawBody);
  }
  const noVersion = await request(server, projectPath(P1.id), { method: "PUT", body: { project: clone(P1) } });
  assert.equal(noVersion.status, 400);
  assert.match(noVersion.body.error, /baseVersion/);

  await delay(300);
  assert.equal(storedBytes(server.dbPath), bytesBefore);
  assert.equal((await getProject(P1.id)).version, version);
  assert.equal(canonicalJson(clientProject(seedClient, P1.id)), canonicalJson(P1));
  assert.equal((await request(server, projectPath(P1.id, "/history"))).body.history.length, historyBefore);
});

test("oversized request bodies are rejected without writing", async () => {
  const { version, project } = await getProject(P1.id);
  const bytesBefore = storedBytes(server.dbPath);
  // Declare an oversized body but never send it: the server must answer 413
  // from the headers alone (and close the connection).
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${server.url}${projectPath(P1.id)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${MASTER}`,
        "Content-Type": "application/json",
        "Content-Length": String(BODY_LIMIT + 1),
      },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ code: res.statusCode, connection: res.headers.connection }));
    });
    req.on("error", reject);
    req.flushHeaders();
  });
  assert.deepEqual(status, { code: 413, connection: "close" });

  // A chunked body without Content-Length is still capped while reading.
  const huge = clone(project);
  huge.info.description = "x".repeat(BODY_LIMIT + 1);
  const chunked = await fetch(`${server.url}${projectPath(P1.id)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${MASTER}`, "Content-Type": "application/json" },
    body: new Blob([JSON.stringify({ baseVersion: version, project: huge })]).stream(),
    duplex: "half",
  }).then((r) => r.status, () => "connection closed");
  assert.ok([400, 413, "connection closed"].includes(chunked), String(chunked));

  // Just under the limit is accepted (and rejected only by validation rules).
  const big = clone(project);
  big.info.description = "y".repeat(BODY_LIMIT - 64 * 1024);
  const ok = await request(server, projectPath(P1.id, "/validate"), { method: "POST", body: { project: big } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal((await getProject(P1.id)).version, version);
  assert.equal(storedBytes(server.dbPath), bytesBefore);
});

test("valid save is atomic, reaches live clients, persists and is recorded in history", async () => {
  const { version, project } = await getProject(P1.id);
  const next = clone(project);
  next.title = "Edited via admin";
  next.tasks[0].completed = !next.tasks[0].completed;
  next.tasks.reverse();
  delete next.fields;

  const watcher = await connect(server);
  const seen = [];
  watcher.doc.on("update", () => seen.push(clientProject(watcher, P1.id)));
  try {
    const res = await request(server, projectPath(P1.id), { method: "PUT", body: { baseVersion: version, project: next } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.version, projectVersion(next));
    assert.equal(res.body.unchanged, false);

    await waitFor(() => clientProject(watcher, P1.id)?.title === next.title, "live update");
    // A single Yjs transaction: the client never observes a half-applied project.
    assert.equal(seen.length, 1);
    assert.equal(canonicalJson(seen[0]), canonicalJson(next));
    assert.equal(canonicalJson(clientProject(seedClient, P1.id)), canonicalJson(next));
    // Other projects are untouched.
    assert.equal(canonicalJson(clientProject(watcher, P2.id)), canonicalJson(P2));
  } finally {
    disconnect(watcher);
  }

  // Stored immediately (no debounce wait needed).
  const stored = storedProjects(server.dbPath).find((p) => p.id === P1.id);
  assert.equal(canonicalJson(stored), canonicalJson(next));

  const history = await request(server, projectPath(P1.id, "/history"));
  assert.equal(history.status, 200);
  const [latest] = history.body.history;
  assert.equal(latest.version, version);
  assert.equal(latest.reason, "edit");
  const entry = await request(server, projectPath(P1.id, `/history/${latest.id}`));
  assert.equal(canonicalJson(entry.body.project), canonicalJson(project));

  // Saving the same content again is a no-op and adds no history.
  const again = await request(server, projectPath(P1.id), {
    method: "PUT",
    body: { baseVersion: projectVersion(next), project: next },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.unchanged, true);
  assert.equal((await request(server, projectPath(P1.id, "/history"))).body.history.length, history.body.history.length);
});

test("stale baseVersion is a 409 conflict and keeps the other edit", async () => {
  const { version, project } = await getProject(P2.id);

  // Someone else edits the project from a live client after we loaded it.
  const yProjects = seedClient.doc.getMap("root").get("projects");
  const yP2 = yProjects.toArray().find((m) => m.get("id") === P2.id);
  seedClient.doc.transact(() => yP2.set("title", "Changed in the app"));
  await waitFor(async () => (await getProject(P2.id)).project.title === "Changed in the app", "remote edit");

  const mine = clone(project);
  mine.title = "My admin edit";
  const res = await request(server, projectPath(P2.id), { method: "PUT", body: { baseVersion: version, project: mine } });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /changed by someone else.*nothing was saved.*reload/i);
  const latest = await getProject(P2.id);
  assert.equal(res.body.currentVersion, latest.version);
  assert.equal(latest.project.title, "Changed in the app");
  assert.equal(clientProject(seedClient, P2.id).title, "Changed in the app");

  // Reload + retry succeeds.
  const retry = clone(latest.project);
  retry.title = "My admin edit";
  const ok = await request(server, projectPath(P2.id), { method: "PUT", body: { baseVersion: latest.version, project: retry } });
  assert.equal(ok.status, 200);
  await waitFor(() => clientProject(seedClient, P2.id).title === "My admin edit", "retry reached client");
});

test("concurrent saves with the same baseVersion: exactly one wins", async () => {
  const { version, project } = await getProject(P3.id);
  const attempts = Array.from({ length: 6 }, (_, i) => {
    const next = clone(project);
    next.title = `Concurrent ${i}`;
    return request(server, projectPath(P3.id), { method: "PUT", body: { baseVersion: version, project: next } });
  });
  const results = await Promise.all(attempts);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409, 409, 409]);
  const winner = results.find((r) => r.status === 200);
  const now = await getProject(P3.id);
  assert.equal(now.version, winner.body.version);
  assert.match(now.project.title, /^Concurrent \d$/);
});

test("PATCH merges top-level fields, null deletes, id is protected, stale is 409", async () => {
  const { version, project } = await getProject(P3.id);
  const res = await request(server, projectPath(P3.id), {
    method: "PATCH",
    body: { baseVersion: version, patch: { title: "Patched", fields: null, position: { x: 1, y: 2 } } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const now = await getProject(P3.id);
  assert.equal(now.project.title, "Patched");
  assert.equal("fields" in now.project, false);
  assert.deepEqual(now.project.position, { x: 1, y: 2 });
  assert.equal(canonicalJson(now.project.tasks), canonicalJson(project.tasks));

  const stale = await request(server, projectPath(P3.id), { method: "PATCH", body: { baseVersion: version, patch: { title: "x" } } });
  assert.equal(stale.status, 409);
  const idPatch = await request(server, projectPath(P3.id), { method: "PATCH", body: { baseVersion: now.version, patch: { id: "y" } } });
  assert.ok([400, 422].includes(idPatch.status));
  const badPatch = await request(server, projectPath(P3.id), { method: "PATCH", body: { baseVersion: now.version, patch: { title: 7 } } });
  assert.equal(badPatch.status, 422);
  assert.equal((await getProject(P3.id)).version, now.version);
});

test("history keeps the last N versions and restore rolls back atomically", async () => {
  const id = P1.id;
  for (let i = 0; i < HISTORY_LIMIT + 2; i += 1) {
    const { version, project } = await getProject(id);
    project.title = `Revision ${i}`;
    const res = await request(server, projectPath(id), { method: "PUT", body: { baseVersion: version, project } });
    assert.equal(res.status, 200);
  }
  const history = (await request(server, projectPath(id, "/history"))).body.history;
  assert.equal(history.length, HISTORY_LIMIT);
  assert.deepEqual(history.map((h) => h.title), ["Revision 3", "Revision 2", "Revision 1"]);

  const target = history[2]; // "Revision 1"
  const current = await getProject(id);
  const stale = await request(server, projectPath(id, `/history/${target.id}/restore`), {
    method: "POST",
    body: { baseVersion: "0".repeat(32) },
  });
  assert.equal(stale.status, 409);

  const restored = await request(server, projectPath(id, `/history/${target.id}/restore`), {
    method: "POST",
    body: { baseVersion: current.version },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const after = await getProject(id);
  assert.equal(after.project.title, "Revision 1");
  assert.equal(after.version, target.version);
  await waitFor(() => clientProject(seedClient, id).title === "Revision 1", "restore reached client");

  // The version that was replaced by the restore is itself in history, so a restore can be undone.
  const afterHistory = (await request(server, projectPath(id, "/history"))).body.history;
  assert.equal(afterHistory[0].version, current.version);
  assert.equal(afterHistory[0].reason, "restore");
  assert.equal(afterHistory.length, HISTORY_LIMIT);

  assert.equal((await request(server, projectPath(id, "/history/999999"))).status, 404);
});

test("edits survive a server restart, history included", async () => {
  const { version, project } = await getProject(P2.id);
  project.title = "Before restart";
  assert.equal((await request(server, projectPath(P2.id), { method: "PUT", body: { baseVersion: version, project } })).status, 200);
  const historyBefore = (await request(server, projectPath(P2.id, "/history"))).body.history;

  disconnect(seedClient);
  seedClient = null;
  await server.stop();
  server = await startServer(dataDir);

  // Document is not loaded any more: reads come from SQLite.
  const now = await getProject(P2.id);
  assert.equal(now.project.title, "Before restart");
  assert.equal(now.version, projectVersion(project));
  assert.deepEqual((await request(server, projectPath(P2.id, "/history"))).body.history, historyBefore);

  // Editing a document with no connected clients works and is stored.
  now.project.title = "Edited offline";
  const res = await request(server, projectPath(P2.id), { method: "PUT", body: { baseVersion: now.version, project: now.project } });
  assert.equal(res.status, 200);
  assert.equal(storedProjects(server.dbPath).find((p) => p.id === P2.id).title, "Edited offline");
  seedClient = await connect(server);
  assert.equal(clientProject(seedClient, P2.id).title, "Edited offline");
});
