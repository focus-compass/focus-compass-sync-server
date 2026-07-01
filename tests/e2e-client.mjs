#!/usr/bin/env node
/**
 * End-to-end sync client test for Focus Compass Sync Server.
 *
 * Emulates what the Focus Compass app does:
 *   - connects with HocuspocusProvider (same library + params as the app),
 *   - writes the same Yjs structure the app uses (root map -> workspace / projects),
 *   - verifies persistence through a second client and the REST snapshot API.
 *
 * Phases:
 *   full    (default) health -> auth setup -> negative auth -> write -> REST
 *           snapshot -> independent read-back -> reconnect. Writes state file.
 *   verify  Re-checks that data written by a previous `full` run is still
 *           there (run it after a server/container restart to prove that
 *           persistence survives restarts). Requires --state-file.
 *
 * Usage:
 *   node tests/e2e-client.mjs [--server http://127.0.0.1:8080] [--token TOKEN]
 *                             [--doc NAME] [--phase full|verify]
 *                             [--state-file PATH] [--sync-timeout MS]
 *
 * Environment fallbacks: E2E_SERVER_URL, E2E_TOKEN, E2E_DOC_NAME.
 * Exit code: 0 when every step passed, 1 otherwise.
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";

// ---------------------------------------------------------------------------
// CLI / config
// ---------------------------------------------------------------------------

const parseArgs = (argv) => {
  const options = {
    server: process.env.E2E_SERVER_URL || "http://127.0.0.1:8080",
    token: process.env.E2E_TOKEN || "",
    doc: process.env.E2E_DOC_NAME || "",
    phase: "full",
    stateFile: "",
    syncTimeoutMs: 20000,
    storeTimeoutMs: 30000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };

    switch (arg) {
      case "--server": options.server = next(); break;
      case "--token": options.token = next(); break;
      case "--doc": options.doc = next(); break;
      case "--phase": options.phase = next(); break;
      case "--state-file": options.stateFile = next(); break;
      case "--sync-timeout": options.syncTimeoutMs = Number(next()); break;
      case "--store-timeout": options.storeTimeoutMs = Number(next()); break;
      case "--help":
      case "-h":
        console.log("See file header for usage.");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!["full", "verify"].includes(options.phase)) {
    throw new Error(`--phase must be "full" or "verify", got: ${options.phase}`);
  }

  return options;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const toHttpUrl = (url) => url
  .replace(/^wss:\/\//, "https://")
  .replace(/^ws:\/\//, "http://")
  .replace(/\/+$/, "");

const toWsUrl = (url) => toHttpUrl(url)
  .replace(/^https:\/\//, "wss://")
  .replace(/^http:\/\//, "ws://");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const runStep = async (name, fn) => {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - startedAt;
    results.push({ name, ok: true, ms });
    console.log(`[ok]   ${name} (${ms}ms)${detail ? ` — ${detail}` : ""}`);
    return true;
  } catch (err) {
    const ms = Date.now() - startedAt;
    results.push({ name, ok: false, ms, error: String(err?.message ?? err) });
    console.error(`[FAIL] ${name} (${ms}ms) — ${err?.message ?? err}`);
    return false;
  }
};

const fetchJson = async (url, { token, method = "GET", expectStatus = 200 } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { method, headers });
  if (response.status !== expectStatus) {
    const body = await response.text().catch(() => "");
    throw new Error(`${method} ${url} -> HTTP ${response.status} (expected ${expectStatus}) ${body.slice(0, 200)}`);
  }

  if (expectStatus === 204) return null;
  return response.json();
};

class AuthFailedError extends Error {}

/**
 * Connects a Hocuspocus client the same way the app does and resolves after
 * the initial sync handshake. Rejects on authentication failure or timeout.
 */
const connectClient = ({ wsUrl, docName, token, timeoutMs, label }) => {
  const doc = new Y.Doc();

  return new Promise((resolve, reject) => {
    let settled = false;
    let provider;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { provider?.destroy(); } catch { /* already closed */ }
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new Error(`${label}: no initial sync after ${timeoutMs}ms (server unreachable, port not exposed, or WS handshake stuck)`)),
      timeoutMs,
    );

    provider = new HocuspocusProvider({
      url: wsUrl,
      name: docName,
      token,
      document: doc,
      onSynced: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ doc, provider });
      },
      onAuthenticationFailed: ({ reason }) => {
        fail(new AuthFailedError(`${label}: authentication failed (${reason || "no reason"})`));
      },
    });
  });
};

const destroyClient = (client) => {
  try { client?.provider?.destroy(); } catch { /* ignore */ }
  try { client?.doc?.destroy(); } catch { /* ignore */ }
};

/**
 * Waits for a subsequent `synced` event on an existing provider —
 * used for the reconnect check.
 */
const waitForResync = (provider, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    provider.off("synced", onSynced);
    reject(new Error(`no re-sync after ${timeoutMs}ms`));
  }, timeoutMs);

  const onSynced = () => {
    clearTimeout(timer);
    provider.off("synced", onSynced);
    resolve();
  };

  provider.on("synced", onSynced);
});

// ---------------------------------------------------------------------------
// Test data — mirrors the structure the app stores in the root map
// (see focus-compass-app src/lib/yjs-store.ts: doc.getMap('root'))
// ---------------------------------------------------------------------------

const buildRunData = (runId) => ({
  workspaceName: `E2E Workspace ${runId}`,
  workspaceId: `e2e-ws-${runId}`,
  marker: `e2e-marker-${runId}`,
  projects: [
    { id: `e2e-project-a-${runId}`, title: `E2E Project Alpha ${runId}`, description: "Created by e2e-client (alpha)" },
    { id: `e2e-project-b-${runId}`, title: `E2E Project Beta ${runId}`, description: "Created by e2e-client (beta)" },
  ],
});

const writeWorkspaceData = (doc, data) => {
  doc.transact(() => {
    const root = doc.getMap("root");

    const workspace = new Y.Map();
    workspace.set("id", data.workspaceId);
    workspace.set("name", data.workspaceName);
    root.set("workspace", workspace);

    const projects = new Y.Array();
    for (const projectData of data.projects) {
      const project = new Y.Map();
      project.set("id", projectData.id);
      project.set("title", projectData.title);

      const info = new Y.Map();
      info.set("description", projectData.description);
      project.set("info", info);

      projects.push([project]);
    }
    root.set("projects", projects);

    root.set("e2eMarker", data.marker);
    root.set("lastUpdatedAt", new Date().toISOString());
  }, "e2e-client");
};

const readWorkspaceData = (doc) => {
  const root = doc.getMap("root");
  const workspace = root.get("workspace");
  const projects = root.get("projects");

  return {
    workspaceId: workspace?.get?.("id") ?? null,
    workspaceName: workspace?.get?.("name") ?? null,
    marker: root.get("e2eMarker") ?? null,
    projectTitles: projects?.toArray?.().map((p) => p?.get?.("title") ?? null) ?? [],
  };
};

const assertWorkspaceData = (actual, expected, label) => {
  if (actual.marker !== expected.marker) {
    throw new Error(`${label}: marker mismatch — expected "${expected.marker}", got "${actual.marker}"`);
  }
  if (actual.workspaceName !== expected.workspaceName) {
    throw new Error(`${label}: workspace name mismatch — expected "${expected.workspaceName}", got "${actual.workspaceName}"`);
  }
  const expectedTitles = expected.projects.map((p) => p.title);
  const missing = expectedTitles.filter((t) => !actual.projectTitles.includes(t));
  if (missing.length > 0) {
    throw new Error(`${label}: missing projects: ${missing.join(", ")} (got: ${actual.projectTitles.join(", ") || "none"})`);
  }
};

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

const runFullPhase = async (options) => {
  const httpUrl = toHttpUrl(options.server);
  const wsUrl = toWsUrl(options.server);
  const runId = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const docName = options.doc || `e2e-test-${runId}`;
  const data = buildRunData(runId);
  let token = options.token;

  console.log(`e2e-client: phase=full server=${httpUrl} doc=${docName}`);

  await runStep("health endpoint responds", async () => {
    const body = await fetchJson(`${httpUrl}/health`);
    if (body?.ok !== true) throw new Error(`unexpected body: ${JSON.stringify(body)}`);
  });

  await runStep("auth status readable without token", async () => {
    const status = await fetchJson(`${httpUrl}/api/auth/status`);
    if (typeof status?.initialized !== "boolean") {
      throw new Error(`unexpected body: ${JSON.stringify(status)}`);
    }
    return `initialized=${status.initialized} envManaged=${status.envManaged} version=${status.version || "?"}`;
  });

  await runStep("master token available", async () => {
    if (token) return "using provided token";

    const status = await fetchJson(`${httpUrl}/api/auth/status`);
    if (status.initialized) {
      throw new Error("server is already initialized — pass --token (or E2E_TOKEN) to test it");
    }

    const setup = await fetchJson(`${httpUrl}/api/auth/setup`, { method: "POST" });
    if (!setup?.token) throw new Error(`setup did not return a token: ${JSON.stringify(setup)}`);
    token = setup.token;
    return "generated via /api/auth/setup (first-run setup mode)";
  });

  if (!token) {
    // Every remaining step needs the token; bail out with a clear summary.
    return { docName, token, data, ok: false };
  }

  await runStep("REST rejects missing token", async () => {
    await fetchJson(`${httpUrl}/api/workspace/${encodeURIComponent(docName)}`, { expectStatus: 401 });
  });

  await runStep("websocket rejects an invalid token", async () => {
    try {
      const client = await connectClient({
        wsUrl,
        docName,
        token: `invalid-${randomBytes(8).toString("hex")}`,
        timeoutMs: Math.min(options.syncTimeoutMs, 15000),
        label: "bad-token client",
      });
      destroyClient(client);
      throw new Error("server accepted an invalid token (sync succeeded)");
    } catch (err) {
      if (err instanceof AuthFailedError) return "rejected as expected";
      throw err;
    }
  });

  let writer;
  await runStep("client A connects and syncs (like the app)", async () => {
    writer = await connectClient({
      wsUrl,
      docName,
      token,
      timeoutMs: options.syncTimeoutMs,
      label: "writer client",
    });
  });

  if (writer) {
    await runStep("client A writes workspace + projects", async () => {
      writeWorkspaceData(writer.doc, data);
      const readBack = readWorkspaceData(writer.doc);
      assertWorkspaceData(readBack, data, "local read-back");
    });

    await runStep("server persists the document (REST snapshot)", async () => {
      // Hocuspocus stores with debounce 2s / maxDebounce 10s — poll until visible.
      const deadline = Date.now() + options.storeTimeoutMs;
      let lastError = "";

      while (Date.now() < deadline) {
        try {
          const snapshot = await fetchJson(
            `${httpUrl}/api/workspace/${encodeURIComponent(docName)}`,
            { token },
          );
          const titles = (snapshot?.projects ?? []).map((p) => p?.title).filter(Boolean);
          const allThere = snapshot?.workspace?.name === data.workspaceName
            && data.projects.every((p) => titles.includes(p.title));

          if (allThere) {
            return `document="${snapshot.document}" projects=${titles.length}`;
          }
          lastError = `snapshot not complete yet: workspace=${JSON.stringify(snapshot?.workspace)} projects=${JSON.stringify(titles)}`;
        } catch (err) {
          lastError = String(err?.message ?? err);
        }
        await sleep(1000);
      }

      throw new Error(`document never became visible over REST within ${options.storeTimeoutMs}ms — last: ${lastError}`);
    });

    await runStep("independent client B receives the data", async () => {
      const reader = await connectClient({
        wsUrl,
        docName,
        token,
        timeoutMs: options.syncTimeoutMs,
        label: "reader client",
      });
      try {
        // Initial handshake is done; give document broadcast a brief moment.
        const deadline = Date.now() + 5000;
        let lastErr;
        for (;;) {
          try {
            assertWorkspaceData(readWorkspaceData(reader.doc), data, "client B");
            break;
          } catch (err) {
            lastErr = err;
            if (Date.now() > deadline) throw lastErr;
            await sleep(250);
          }
        }
      } finally {
        destroyClient(reader);
      }
    });

    await runStep("client A survives disconnect/reconnect", async () => {
      writer.provider.disconnect();
      await sleep(300);
      const resynced = waitForResync(writer.provider, options.syncTimeoutMs);
      writer.provider.connect();
      await resynced;
    });

    destroyClient(writer);
  }

  if (options.stateFile) {
    const state = {
      serverUrl: httpUrl,
      token,
      docName,
      runId,
      expected: data,
      writtenAt: new Date().toISOString(),
    };
    await writeFile(options.stateFile, JSON.stringify(state, null, 2), "utf8");
    console.log(`state written to ${options.stateFile}`);
  }

  return { docName, token, data };
};

const runVerifyPhase = async (options) => {
  if (!options.stateFile) {
    throw new Error("--phase verify requires --state-file from a previous full run");
  }

  const state = JSON.parse(await readFile(options.stateFile, "utf8"));
  const serverUrl = options.server !== "http://127.0.0.1:8080" || !state.serverUrl
    ? options.server
    : state.serverUrl;
  const httpUrl = toHttpUrl(serverUrl);
  const wsUrl = toWsUrl(serverUrl);
  const token = options.token || state.token;
  const docName = options.doc || state.docName;

  console.log(`e2e-client: phase=verify server=${httpUrl} doc=${docName} (run ${state.runId})`);

  await runStep("health endpoint responds", async () => {
    const body = await fetchJson(`${httpUrl}/health`);
    if (body?.ok !== true) throw new Error(`unexpected body: ${JSON.stringify(body)}`);
  });

  await runStep("auth survived the restart (setup stays locked)", async () => {
    const status = await fetchJson(`${httpUrl}/api/auth/status`);
    if (status.initialized !== true) {
      throw new Error("server lost its token after restart (auth.json not persisted?)");
    }
    await fetchJson(`${httpUrl}/api/auth/setup`, { method: "POST", expectStatus: 409 });
  });

  await runStep("document survived the restart (websocket)", async () => {
    const reader = await connectClient({
      wsUrl,
      docName,
      token,
      timeoutMs: options.syncTimeoutMs,
      label: "verify client",
    });
    try {
      const deadline = Date.now() + 5000;
      let lastErr;
      for (;;) {
        try {
          assertWorkspaceData(readWorkspaceData(reader.doc), state.expected, "verify client");
          break;
        } catch (err) {
          lastErr = err;
          if (Date.now() > deadline) throw lastErr;
          await sleep(250);
        }
      }
    } finally {
      destroyClient(reader);
    }
  });

  await runStep("document survived the restart (REST snapshot)", async () => {
    const snapshot = await fetchJson(
      `${httpUrl}/api/workspace/${encodeURIComponent(docName)}`,
      { token },
    );
    const titles = (snapshot?.projects ?? []).map((p) => p?.title).filter(Boolean);
    if (snapshot?.workspace?.name !== state.expected.workspaceName) {
      throw new Error(`workspace name mismatch after restart: ${JSON.stringify(snapshot?.workspace)}`);
    }
    const missing = state.expected.projects.filter((p) => !titles.includes(p.title));
    if (missing.length > 0) {
      throw new Error(`projects missing after restart: ${missing.map((p) => p.title).join(", ")}`);
    }
    return `projects=${titles.length}`;
  });
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.phase === "full") {
    await runFullPhase(options);
  } else {
    await runVerifyPhase(options);
  }

  const failed = results.filter((r) => !r.ok);
  const summary = {
    phase: options.phase,
    passed: results.length - failed.length,
    failed: failed.length,
    steps: results,
  };
  console.log(`E2E_JSON ${JSON.stringify(summary)}`);

  if (failed.length > 0) {
    console.error(`E2E RESULT: FAIL (${failed.length}/${results.length} steps failed)`);
    return 1;
  }

  console.log(`E2E RESULT: PASS (${results.length} steps)`);
  return 0;
};

main()
  .catch((err) => {
    console.error(`E2E RESULT: FAIL — ${err?.stack ?? err}`);
    return 1;
  })
  .then(async (code) => {
    // Give freshly-destroyed websockets a beat to finish closing before the
    // hard exit — otherwise libuv on Windows can hit a double-close assertion
    // (win/async.c) and mangle the exit code.
    await sleep(250);
    process.exit(code);
  });
