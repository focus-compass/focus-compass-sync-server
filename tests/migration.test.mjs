import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { HocuspocusProvider as HocuspocusProviderV4 } from "@hocuspocus/provider";
import { HocuspocusProvider as HocuspocusProviderV3 } from "@hocuspocus/provider-v3";
import WebSocket from "ws";
import * as Y from "yjs";
import { MAX_DOC_NAME_LENGTH } from "../src/lib/db.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(TESTS_DIR);
const LEGACY_FIXTURE_DIR = join(TESTS_DIR, "fixtures", "hocuspocus-v3");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async (promise, timeoutMs, message) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const waitFor = async (predicate, {
  timeoutMs = 10_000,
  intervalMs = 50,
  message = "condition was not met",
} = {}) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }

  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
};

const getFreePort = async () => {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => listener.close((error) => (
    error ? reject(error) : resolve()
  )));
  return port;
};

const fetchJson = async (url, {
  method = "GET",
  token,
  expectedStatus = 200,
  jsonBody,
} = {}) => {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (jsonBody !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${method} ${url}: ${text}`);
  return text ? JSON.parse(text) : null;
};

const startServer = async ({ dataDir, extraEnv = {} }) => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      ACCESS_TOKEN: "",
      MCP_TOKEN: "",
      DB_PATH: join(dataDir, "db.sqlite"),
      IMAGES_DIR: join(dataDir, "images"),
      BACKUP_DIR: join(dataDir, "backups"),
      AUTH_FILE_PATH: join(dataDir, "auth.json"),
      MCP_AUTH_FILE_PATH: join(dataDir, "mcp-auth.json"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const httpUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`server exited ${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const response = await fetch(`${httpUrl}/health`).catch(() => null);
    return response?.ok;
  }, { timeoutMs: 15_000, message: "server did not become healthy" });

  return {
    child,
    closed,
    dataDir,
    httpUrl,
    wsUrl,
    logs: () => `${stdout}\n${stderr}`,
  };
};

const stopServer = async (server) => {
  if (!server) return;
  if (server.child.exitCode === null) {
    server.child.kill(process.platform === "win32" ? undefined : "SIGTERM");
  }
  let timer;
  let timedOut = false;
  try {
    await Promise.race([
      server.closed,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    if (server.child.exitCode === null) server.child.kill("SIGKILL");
    await Promise.race([server.closed, delay(5_000)]);
    throw new Error(`server did not finish graceful shutdown for ${server.dataDir}`);
  }

  if (process.platform !== "win32") {
    assert.equal(server.child.exitCode, 0, server.logs());
  }
  server.child.unref();
};

const connectProvider = ({
  Provider = HocuspocusProviderV4,
  wsUrl,
  docName,
  token,
  timeoutMs = 10_000,
}) => new Promise((resolve, reject) => {
  const doc = new Y.Doc();
  let provider;
  let settled = false;

  const finish = (callback) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback();
  };

  const timer = setTimeout(() => finish(() => {
    provider?.configuration?.websocketProvider?.setConfiguration?.({ autoConnect: false });
    provider?.destroy();
    doc.destroy();
    reject(new Error(`provider did not sync ${docName}`));
  }), timeoutMs);

  provider = new Provider({
    url: wsUrl,
    name: docName,
    token,
    document: doc,
    // Test connections target an already-healthy local server. Bound retry
    // attempts so deliberate authentication/protocol failures cannot leave
    // @lifeomic/attempt backoff timers running after provider teardown.
    delay: 10,
    minDelay: 10,
    maxDelay: 10,
    maxAttempts: 2,
    jitter: false,
    onSynced: () => finish(() => resolve({ doc, provider })),
    onAuthenticationFailed: ({ reason }) => finish(() => {
      provider.configuration.websocketProvider.setConfiguration({ autoConnect: false });
      provider.destroy();
      doc.destroy();
      reject(new Error(`authentication failed: ${reason || "unknown"}`));
    }),
  });
});

const expectAuthenticationFailure = async (options) => {
  await assert.rejects(connectProvider(options), /authentication failed/i);
};

const disableReconnect = (client) => {
  client?.provider?.configuration?.websocketProvider?.setConfiguration?.({
    autoConnect: false,
  });
};

const destroyClient = (client) => {
  try { disableReconnect(client); } catch { /* already closed */ }
  try { client?.provider?.destroy(); } catch { /* already closed */ }
  try { client?.doc?.destroy(); } catch { /* already closed */ }
};

const readDocumentNames = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents'",
    ).get();
    if (!exists) return [];
    return db.prepare("SELECT name FROM documents ORDER BY name").all().map((row) => row.name);
  } finally {
    db.close();
  }
};

const waitForStoredDocument = (dbPath, docName) => waitFor(() => (
  readDocumentNames(dbPath).includes(docName)
), { timeoutMs: 15_000, message: `document ${docName} was not persisted` });

const openRawWebSocket = async (wsUrl) => {
  const socket = new WebSocket(wsUrl, { perMessageDeflate: false });
  await Promise.race([
    once(socket, "open"),
    once(socket, "error").then(([error]) => Promise.reject(error)),
  ]);
  return socket;
};

const waitForSocketClose = async (socket, timeoutMs = 5_000) => {
  if (socket.readyState === WebSocket.CLOSED) return;
  try {
    await withTimeout(
      once(socket, "close"),
      timeoutMs,
      "WebSocket was not closed by the server",
    );
  } catch (error) {
    if (socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
    throw error;
  }
};

const encodeVarUint = (value) => {
  const bytes = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining & 0x7f);
  return Buffer.from(bytes);
};

const makeQueuedSyncMessage = (docName, totalBytes) => {
  const name = Buffer.from(docName, "utf8");
  const header = Buffer.concat([
    encodeVarUint(name.length),
    name,
    encodeVarUint(0),
  ]);
  assert.ok(totalBytes >= header.length);
  return Buffer.concat([header, Buffer.alloc(totalBytes - header.length)]);
};

const assertHealthy = async (httpUrl) => {
  const health = await fetchJson(`${httpUrl}/health`);
  assert.equal(health.ok, true);
};

test("Hocuspocus 4 migration", { concurrency: 1 }, async (t) => {
  await t.test("setup, auth, v3/v4 sync, persistence, and token rotation", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "focus-compass-v4-core-"));
    const dataDir = join(root, "data");
    const dbPath = join(dataDir, "db.sqlite");
    const authPath = join(dataDir, "auth.json");
    let server = await startServer({ dataDir });
    let writer;
    let reader;
    let legacyClient;

    try {
      await assertHealthy(server.httpUrl);

      const initialStatus = await fetchJson(`${server.httpUrl}/api/auth/status`);
      assert.equal(initialStatus.initialized, false);

      const setup = await fetchJson(`${server.httpUrl}/api/auth/setup`, { method: "POST" });
      assert.match(setup.token, /^[A-Za-z0-9_-]{32}$/);
      const originalAuth = await readFile(authPath, "utf8");

      await fetchJson(`${server.httpUrl}/api/auth/setup`, {
        method: "POST",
        expectedStatus: 409,
      });
      assert.equal(await readFile(authPath, "utf8"), originalAuth);
      assert.equal(server.logs().includes(setup.token), false, "master token appeared in logs");

      const rejectedDoc = "unauthorized-must-not-exist";
      await expectAuthenticationFailure({
        wsUrl: server.wsUrl,
        docName: rejectedDoc,
        token: "wrong-token",
      });
      await expectAuthenticationFailure({
        wsUrl: server.wsUrl,
        docName: rejectedDoc,
        token: null,
      });
      assert.equal(readDocumentNames(dbPath).includes(rejectedDoc), false);

      writer = await connectProvider({
        wsUrl: server.wsUrl,
        docName: "live-v4-document",
        token: setup.token,
      });
      reader = await connectProvider({
        wsUrl: server.wsUrl,
        docName: "live-v4-document",
        token: setup.token,
      });
      writer.doc.getMap("root").set("migrationMarker", "written-by-v4");
      await waitFor(
        () => reader.doc.getMap("root").get("migrationMarker") === "written-by-v4",
        { message: "second v4 client did not receive the update" },
      );

      legacyClient = await connectProvider({
        Provider: HocuspocusProviderV3,
        wsUrl: server.wsUrl,
        docName: "live-v4-document",
        token: setup.token,
      });
      assert.equal(legacyClient.doc.getMap("root").get("migrationMarker"), "written-by-v4");
      legacyClient.doc.getMap("root").set("legacyProviderMarker", "written-by-v3");
      await waitFor(
        () => reader.doc.getMap("root").get("legacyProviderMarker") === "written-by-v3",
        { message: "v4 client did not receive the v3 provider update" },
      );

      destroyClient(legacyClient);
      destroyClient(reader);
      destroyClient(writer);
      legacyClient = null;
      reader = null;
      writer = null;
      await waitForStoredDocument(dbPath, "live-v4-document");

      await stopServer(server);
      server = await startServer({ dataDir });
      const restartedStatus = await fetchJson(`${server.httpUrl}/api/auth/status`);
      assert.equal(restartedStatus.initialized, true);
      await fetchJson(`${server.httpUrl}/api/auth/setup`, {
        method: "POST",
        expectedStatus: 409,
      });

      reader = await connectProvider({
        wsUrl: server.wsUrl,
        docName: "live-v4-document",
        token: setup.token,
      });
      assert.equal(reader.doc.getMap("root").get("migrationMarker"), "written-by-v4");
      assert.equal(reader.doc.getMap("root").get("legacyProviderMarker"), "written-by-v3");
      destroyClient(reader);
      reader = null;

      const nextToken = "replacement-token-for-migration-test";
      const rotated = await fetchJson(`${server.httpUrl}/api/auth/rotate`, {
        method: "POST",
        token: setup.token,
        jsonBody: { token: nextToken },
      });
      assert.equal(rotated.token, nextToken);

      await expectAuthenticationFailure({
        wsUrl: server.wsUrl,
        docName: "revoked-token-must-not-connect",
        token: setup.token,
      });
      const rotatedClient = await connectProvider({
        wsUrl: server.wsUrl,
        docName: "rotated-token-connects",
        token: nextToken,
      });
      destroyClient(rotatedClient);
      assert.equal(
        readDocumentNames(dbPath).includes("revoked-token-must-not-connect"),
        false,
      );
      assert.equal(server.logs().includes(nextToken), false, "rotated token appeared in logs");
    } finally {
      destroyClient(legacyClient);
      destroyClient(reader);
      destroyClient(writer);
      await stopServer(server);
    }
  });

  await t.test("real Hocuspocus 3 SQLite fixture loads and round-trips unchanged", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "focus-compass-v3-fixture-"));
    const dataDir = join(root, "data");
    await cp(LEGACY_FIXTURE_DIR, dataDir, { recursive: true });
    const state = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8"));
    const authPath = join(dataDir, "auth.json");
    const authBefore = createHash("sha256").update(await readFile(authPath)).digest("hex");
    let server = await startServer({ dataDir });
    let v3Client;
    let v4Client;

    try {
      v3Client = await connectProvider({
        Provider: HocuspocusProviderV3,
        wsUrl: server.wsUrl,
        docName: state.docName,
        token: state.token,
      });
      assert.equal(v3Client.doc.getMap("root").get("e2eMarker"), state.expected.marker);

      v4Client = await connectProvider({
        wsUrl: server.wsUrl,
        docName: state.docName,
        token: state.token,
      });
      assert.equal(v4Client.doc.getMap("root").get("e2eMarker"), state.expected.marker);

      v3Client.doc.getMap("root").set("v4MigrationRoundTrip", "survives-restart");
      await waitFor(
        () => v4Client.doc.getMap("root").get("v4MigrationRoundTrip") === "survives-restart",
        { message: "legacy provider update did not reach the v4 client" },
      );
      destroyClient(v3Client);
      destroyClient(v4Client);
      v3Client = null;
      v4Client = null;
      await delay(2_500);

      await stopServer(server);
      server = await startServer({ dataDir });
      v4Client = await connectProvider({
        wsUrl: server.wsUrl,
        docName: state.docName,
        token: state.token,
      });
      assert.equal(v4Client.doc.getMap("root").get("e2eMarker"), state.expected.marker);
      assert.equal(
        v4Client.doc.getMap("root").get("v4MigrationRoundTrip"),
        "survives-restart",
      );

      const authAfter = createHash("sha256").update(await readFile(authPath)).digest("hex");
      assert.equal(authAfter, authBefore, "auth.json changed during the migration round-trip");
    } finally {
      destroyClient(v3Client);
      destroyClient(v4Client);
      await stopServer(server);
    }
  });

  await t.test("v3 and v4 clients stay connected beyond the idle timeout", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "focus-compass-v4-long-lived-"));
    const token = "long-lived-connection-token";
    const server = await startServer({
      dataDir: join(root, "data"),
      extraEnv: { ACCESS_TOKEN: token },
    });
    let v3Client;
    let v4Client;

    try {
      v3Client = await connectProvider({
        Provider: HocuspocusProviderV3,
        wsUrl: server.wsUrl,
        docName: "long-lived-document",
        token,
      });
      v4Client = await connectProvider({
        wsUrl: server.wsUrl,
        docName: "long-lived-document",
        token,
      });
      let v3Disconnects = 0;
      let v4Disconnects = 0;
      v3Client.provider.on("disconnect", () => { v3Disconnects += 1; });
      v4Client.provider.on("disconnect", () => { v4Disconnects += 1; });

      // Awareness renewals are emitted every 15 seconds. Waiting beyond the
      // 30-second server timeout proves both supported provider generations
      // keep an otherwise idle connection alive without reconnect churn.
      await delay(32_000);
      assert.equal(v3Disconnects, 0);
      assert.equal(v4Disconnects, 0);

      v3Client.doc.getMap("root").set("afterIdle", "still-connected");
      await waitFor(
        () => v4Client.doc.getMap("root").get("afterIdle") === "still-connected",
        { message: "long-lived clients did not sync after the idle interval" },
      );
    } finally {
      destroyClient(v3Client);
      destroyClient(v4Client);
      await stopServer(server);
    }
  });

  await t.test(
    "SIGTERM flushes a document that is applied but still inside the store debounce window",
    { skip: process.platform === "win32" ? "Windows cannot deliver POSIX SIGTERM to child Node.js processes" : false },
    async () => {
      const root = await mkdtemp(join(os.tmpdir(), "focus-compass-v4-shutdown-"));
      const dataDir = join(root, "data");
      const token = "graceful-shutdown-token";
      let server = await startServer({ dataDir, extraEnv: { ACCESS_TOKEN: token } });
      let writer;
      let observer;

      try {
        writer = await connectProvider({
          wsUrl: server.wsUrl,
          docName: "pending-at-shutdown",
          token,
        });
        observer = await connectProvider({
          wsUrl: server.wsUrl,
          docName: "pending-at-shutdown",
          token,
        });
        writer.doc.getMap("root").set("shutdownMarker", "must-survive");
        await waitFor(
          () => observer.doc.getMap("root").get("shutdownMarker") === "must-survive",
          { message: "server did not apply the pre-shutdown update" },
        );

        // The server is intentionally stopped while both clients are live.
        // Prevent that expected close from starting provider reconnect loops.
        disableReconnect(writer);
        disableReconnect(observer);
        await stopServer(server);
        destroyClient(writer);
        destroyClient(observer);
        writer = null;
        observer = null;

        server = await startServer({ dataDir, extraEnv: { ACCESS_TOKEN: token } });
        observer = await connectProvider({
          wsUrl: server.wsUrl,
          docName: "pending-at-shutdown",
          token,
        });
        assert.equal(observer.doc.getMap("root").get("shutdownMarker"), "must-survive");
      } finally {
        destroyClient(writer);
        destroyClient(observer);
        await stopServer(server);
      }
    },
  );

  await t.test("pre-auth and WebSocket limits reject hostile input without harming service", async () => {
    const root = await mkdtemp(join(os.tmpdir(), "focus-compass-v4-limits-"));
    const dataDir = join(root, "data");
    const token = "security-test-token";
    const server = await startServer({
      dataDir,
      extraEnv: {
        ACCESS_TOKEN: token,
        HOCUSPOCUS_TIMEOUT_MS: "750",
        MAX_WEBSOCKET_MESSAGE_BYTES: "65536",
        MAX_UNAUTHENTICATED_QUEUE_BYTES: "4096",
        MAX_UNAUTHENTICATED_QUEUE_MESSAGES: "4",
        MAX_PENDING_DOCUMENTS: "2",
      },
    });
    let normalClient;

    try {
      const handshake = await openRawWebSocket(server.wsUrl);
      handshake.close();
      await waitForSocketClose(handshake);

      const malformed = await openRawWebSocket(server.wsUrl);
      malformed.send(Buffer.from([0xff]));
      await waitForSocketClose(malformed);
      await assertHealthy(server.httpUrl);

      const oversized = await openRawWebSocket(server.wsUrl);
      oversized.send(Buffer.alloc(65_537));
      await waitForSocketClose(oversized);
      await assertHealthy(server.httpUrl);

      const fragmented = await openRawWebSocket(server.wsUrl);
      fragmented.send(Buffer.alloc(40_000), { binary: true, fin: false });
      fragmented.send(Buffer.alloc(40_000), { binary: true, fin: true });
      await waitForSocketClose(fragmented);
      await assertHealthy(server.httpUrl);

      const queuedBytes = await openRawWebSocket(server.wsUrl);
      queuedBytes.send(makeQueuedSyncMessage("queue-bytes", 2_100));
      queuedBytes.send(makeQueuedSyncMessage("queue-bytes", 2_100));
      await waitForSocketClose(queuedBytes);
      await assertHealthy(server.httpUrl);

      const queuedMessages = await openRawWebSocket(server.wsUrl);
      for (let index = 0; index < 5; index += 1) {
        queuedMessages.send(makeQueuedSyncMessage("queue-messages", 32));
      }
      await waitForSocketClose(queuedMessages);
      await assertHealthy(server.httpUrl);

      const pendingDocuments = await openRawWebSocket(server.wsUrl);
      pendingDocuments.send(makeQueuedSyncMessage("pending-one", 32));
      pendingDocuments.send(makeQueuedSyncMessage("pending-two", 32));
      pendingDocuments.send(makeQueuedSyncMessage("pending-three", 32));
      await waitForSocketClose(pendingDocuments);
      await assertHealthy(server.httpUrl);

      const timedOut = await openRawWebSocket(server.wsUrl);
      await waitForSocketClose(timedOut, 3_000);
      await assertHealthy(server.httpUrl);

      await Promise.all(Array.from({ length: 20 }, (_, index) => (
        expectAuthenticationFailure({
          wsUrl: server.wsUrl,
          docName: `unauthorized-series-${index}`,
          token: "invalid-token",
          timeoutMs: 5_000,
        })
      )));
      await assertHealthy(server.httpUrl);

      await expectAuthenticationFailure({
        wsUrl: server.wsUrl,
        docName: "x".repeat(513),
        token,
      });
      assert.equal(readDocumentNames(join(dataDir, "db.sqlite")).some(
        (name) => name.length > MAX_DOC_NAME_LENGTH,
      ), false);

      normalClient = await connectProvider({
        wsUrl: server.wsUrl,
        docName: "normal-after-attacks",
        token,
      });
      normalClient.doc.getMap("root").set("ok", true);
      destroyClient(normalClient);
      normalClient = null;
      await waitForStoredDocument(join(dataDir, "db.sqlite"), "normal-after-attacks");

      const oversizedClient = await connectProvider({
        wsUrl: server.wsUrl,
        docName: "oversized-authenticated-update",
        token,
      });
      // This test expects the server to close the socket. Disable the client's
      // normal reconnect policy first so a deliberate protocol rejection does
      // not leave a retry timer behind after the assertions complete.
      oversizedClient.provider.configuration.websocketProvider.setConfiguration({
        autoConnect: false,
      });
      const closed = new Promise((resolve) => oversizedClient.provider.on("close", resolve));
      oversizedClient.doc.getMap("root").set("oversized", "x".repeat(128 * 1024));
      await withTimeout(
        closed,
        5_000,
        "oversized authenticated update was accepted",
      );
      destroyClient(oversizedClient);
      await assertHealthy(server.httpUrl);

      normalClient = await connectProvider({
        wsUrl: server.wsUrl,
        docName: "oversized-authenticated-update",
        token,
      });
      assert.equal(normalClient.doc.getMap("root").has("oversized"), false);
    } finally {
      destroyClient(normalClient);
      await stopServer(server);
    }
  });
});
