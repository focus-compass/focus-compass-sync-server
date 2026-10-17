// In-process failure injection for ProjectEditor.saveProject: a failing
// history write or a failing Yjs write must leave the live document, its
// stored copy and connected observers untouched.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { FocusCompassSQLite } from "../src/lib/hocuspocusSqlite.js";
import { ProjectEditor } from "../src/services/projectEditor.js";
import { ProjectHistoryStore } from "../src/services/projectHistory.js";
import * as projectSync from "../src/yjs/projectSync.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const presets = JSON.parse(
  await readFile(join(REPO_ROOT, "tests", "fixtures", "app-projects", "presets.json"), "utf8"),
);
const clone = (v) => JSON.parse(JSON.stringify(v));
const DOC = "atomic-doc";

const setup = async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "fc-project-atomic-"));
  const dbPath = join(dir, "db.sqlite");
  const hocuspocus = new Hocuspocus({ extensions: [new FocusCompassSQLite({ database: dbPath })], quiet: true });
  // Seed the document through Hocuspocus so it is stored the normal way.
  const seed = await hocuspocus.openDirectConnection(DOC, {});
  await seed.transact((doc) => {
    const projects = new Y.Array();
    doc.getMap("root").set("projects", projects);
    projects.push(presets.slice(0, 2).map((p) => projectSync.toYjs(clone(p))));
  });
  await seed.disconnect();
  const history = new ProjectHistoryStore({ dbPath: join(dir, "history.sqlite"), limit: 5 });
  const editor = new ProjectEditor({ hocuspocus, dbPath, history, maxDocDecodeBytes: 64 * 1024 * 1024 });
  return {
    dir,
    dbPath,
    hocuspocus,
    history,
    editor,
    stored: () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return Buffer.from(db.prepare("SELECT data FROM documents WHERE name = ?").get(DOC).data).toString("base64");
      } finally {
        db.close();
      }
    },
    cleanup: async () => {
      history.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
};

test("history write failure aborts the save before anything changes", async () => {
  const ctx = await setup();
  try {
    const { project, version } = ctx.editor.getProject(DOC, presets[0].id);
    const bytes = ctx.stored();
    ctx.history.add = () => { throw new Error("disk full"); };
    const next = clone(project);
    next.title = "Should not land";
    await assert.rejects(
      ctx.editor.saveProject({ docName: DOC, projectId: project.id, baseVersion: version, next, reason: "edit" }),
      /disk full/,
    );
    assert.equal(ctx.editor.getProject(DOC, project.id).version, version);
    assert.equal(ctx.stored(), bytes);
  } finally {
    await ctx.cleanup();
  }
});

test("a write that fails half-way is rolled back inside the same transaction", async () => {
  const ctx = await setup();
  const live = await ctx.hocuspocus.openDirectConnection(DOC, {});
  try {
    const { project, version } = ctx.editor.getProject(DOC, presets[0].id);
    const liveDoc = ctx.hocuspocus.documents.get(DOC);
    const updates = [];
    liveDoc.on("update", (u) => updates.push(u));

    // Make the Yjs write blow up part-way: the title is set, then a nested
    // array insert throws.
    const next = clone(project);
    next.title = "Half applied?";
    next.tasks.push({ id: "boom", text: "x", completed: false, group: project.tasks[0]?.group ?? "g" });
    const yTasks = liveDoc.getMap("root").get("projects").get(0).get("tasks");
    const originalInsert = yTasks.insert.bind(yTasks);
    yTasks.insert = () => { throw new Error("injected failure"); };
    yTasks.push = () => { throw new Error("injected failure"); };

    await assert.rejects(
      ctx.editor.saveProject({ docName: DOC, projectId: project.id, baseVersion: version, next, reason: "edit" }),
      (err) => err.status === 500 && /left unchanged/.test(err.message),
    );
    yTasks.insert = originalInsert;
    delete yTasks.push;

    const after = ctx.editor.getProject(DOC, project.id);
    assert.equal(after.version, version, "project content is exactly the original");
    assert.deepEqual(ctx.history.list(DOC, project.id), [], "no bogus history entry is left behind");
    assert.equal(after.project.title, project.title);
    // Observers saw at most one combined update, and its net effect is no change.
    assert.ok(updates.length <= 1);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(liveDoc));
    const replicaProject = replica.getMap("root").get("projects").get(0).toJSON();
    assert.equal(projectSync.projectVersion(replicaProject), version);
  } finally {
    await live.disconnect();
    await ctx.cleanup();
  }
});
