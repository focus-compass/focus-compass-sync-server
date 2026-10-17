import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as Y from "yjs";
import { validateProject } from "../src/yjs/projectSchema.js";
import { canonicalJson, projectVersion, syncYMap, toYjs } from "../src/yjs/projectSync.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "app-projects", "presets.json");
const presets = JSON.parse(readFileSync(FIXTURE, "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const base = () => clone(presets[0]);
const paths = (result) => result.errors.map((e) => e.path);

test("real app projects pass strict validation with no warnings", () => {
  assert.ok(presets.length >= 10);
  for (const project of presets) {
    const result = validateProject(project, { expectedId: project.id });
    assert.deepEqual(result, { ok: true, errors: [], warnings: [] }, project.id);
  }
});

test("rejects non-objects", () => {
  for (const value of [null, [], "x", 1, true]) {
    const result = validateProject(value);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].path, "project");
  }
});

test("rejects missing required fields", () => {
  const p = base();
  delete p.title;
  delete p.info.image;
  delete p.position;
  const result = validateProject(p, { expectedId: p.id });
  assert.equal(result.ok, false);
  assert.deepEqual(paths(result).sort(), ["project.info.image", "project.position", "project.title"]);
  assert.match(result.errors[0].message, /required field is missing/);
});

test("rejects unknown fields at every level", () => {
  const p = base();
  p.colour = "red";
  p.info.extra = 1;
  p.tasks[0].priority = "high";
  p.position.z = 3;
  p.noteCollections[0].items[0].bogus = true;
  const result = validateProject(p, { expectedId: p.id });
  assert.deepEqual(paths(result).sort(), [
    "project.colour",
    "project.info.extra",
    "project.noteCollections[0].items[0].bogus",
    "project.position.z",
    "project.tasks[0].priority",
  ]);
  for (const e of result.errors) assert.equal(e.message, "unknown field");
});

test("rejects __proto__ / constructor keys from JSON.parse", () => {
  const p = JSON.parse(JSON.stringify(base()).replace(/^\{/, '{"__proto__":{"polluted":true},"constructor":1,'));
  const result = validateProject(p, { expectedId: p.id });
  assert.deepEqual(paths(result).sort(), ['project.__proto__', "project.constructor"]);
  assert.equal({}.polluted, undefined);
});

test("rejects __proto__ keys inside free-form records", () => {
  const p = JSON.parse(JSON.stringify(base()).replace(/^\{/, '{"fields":{"__proto__":"x","ok":"y"},').replace(/,"fields":\{[^}]*\}/, ""));
  const result = validateProject(p, { expectedId: p.id });
  assert.deepEqual(paths(result), ["project.fields.__proto__"]);
});

test("canonicalJson keeps own __proto__ keys, so versions see every change", () => {
  const a = JSON.parse('{"fields":{"__proto__":"1"}}');
  const b = JSON.parse('{"fields":{"__proto__":"2"}}');
  assert.notEqual(projectVersion(a), projectVersion(b));
  assert.equal(canonicalJson(a), '{"fields":{"__proto__":"1"}}');
  assert.equal(canonicalJson({ b: [1, "x", null, true], a: { d: 1.5, c: -0 } }), JSON.stringify({ a: { c: 0, d: 1.5 }, b: [1, "x", null, true] }));
});

test("rejects UI-only (transient) keys", () => {
  const p = base();
  p.isNew = true;
  p.groups[0].isEditingNotes = false;
  const result = validateProject(p, { expectedId: p.id });
  assert.deepEqual(paths(result).sort(), ["project.groups[0].isEditingNotes", "project.isNew"]);
  assert.match(result.errors[0].message, /UI-only/);
});

test("rejects wrong types, enums, non-finite numbers", () => {
  const p = base();
  p.title = 5;
  p.tasks[0].completed = "yes";
  p.position.x = "10";
  p.info.imageFit = "stretch";
  p.template = { id: "t", source: "cloud", version: "1" };
  p.fields = { a: 1 };
  p.tasksLastModifiedAt = Number.NaN; // JSON cannot carry NaN, but the API must not trust callers
  const result = validateProject(p, { expectedId: p.id });
  const byPath = Object.fromEntries(result.errors.map((e) => [e.path, e.message]));
  assert.match(byPath["project.title"], /expected string, got number/);
  assert.match(byPath["project.tasks[0].completed"], /expected boolean, got string/);
  assert.match(byPath["project.position.x"], /expected finite number, got string/);
  assert.match(byPath["project.info.imageFit"], /expected one of/);
  assert.match(byPath["project.template.source"], /expected one of/);
  assert.match(byPath['project.fields.a'], /expected string/);
  assert.match(byPath["project.tasksLastModifiedAt"], /finite number/);
});

test("template may be null; optional fields may be omitted", () => {
  const p = base();
  p.template = null;
  delete p.groups;
  delete p.checklists;
  delete p.selectedChecklistId;
  delete p.noteCollections;
  delete p.fields;
  assert.equal(validateProject(p, { expectedId: p.id }).ok, true);
});

test("rejects id change, empty and duplicate ids", () => {
  const p = base();
  p.id = "other";
  assert.match(validateProject(p, { expectedId: presets[0].id }).errors[0].message, /cannot be changed/);

  const q = clone(presets.find((x) => x.tasks.length >= 2 && x.groups?.length));
  q.tasks[1].id = q.tasks[0].id;
  q.groups[0].id = "";
  const result = validateProject(q, { expectedId: q.id });
  assert.deepEqual(paths(result).sort(), ["project.groups[0].id", "project.tasks[1].id"]);
});

test("dangling references are warnings, not errors", () => {
  const p = base();
  p.tasks[0].group = "missing-group";
  p.selectedChecklistId = "nope";
  const result = validateProject(p, { expectedId: p.id });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings.map((w) => w.path).sort(), ["project.selectedChecklistId", "project.tasks[0].group"]);
});

test("caps the number of reported errors", () => {
  const p = base();
  p.tasks = Array.from({ length: 200 }, () => ({ text: 1, completed: 1, group: 1 }));
  const result = validateProject(p, { expectedId: p.id });
  assert.ok(result.errors.length <= 52);
  assert.equal(result.ok, false);
});

test("caps the number of reported warnings", () => {
  const p = base();
  p.tasks = Array.from({ length: 500 }, (_, i) => ({ id: `t${i}`, text: "x", completed: false, group: "missing" }));
  const result = validateProject(p, { expectedId: p.id });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 51);
  assert.match(result.warnings.at(-1).message, /450 more warnings/);
});

test("projectVersion ignores key order and changes with content", () => {
  const a = { b: 1, a: [1, { y: 2, x: 1 }] };
  const b = { a: [1, { x: 1, y: 2 }], b: 1 };
  assert.equal(projectVersion(a), projectVersion(b));
  assert.notEqual(projectVersion(a), projectVersion({ ...a, b: 2 }));
});

// --- syncYMap ----------------------------------------------------------------
const makeDoc = (project) => {
  const doc = new Y.Doc();
  const projects = new Y.Array();
  doc.getMap("root").set("projects", projects);
  projects.push([toYjs(project)]);
  return { doc, yProject: projects.get(0) };
};

const syncAndCheck = (before, after) => {
  const { doc, yProject } = makeDoc(before);
  const updates = [];
  doc.on("update", (u) => updates.push(u));
  doc.transact(() => syncYMap(yProject, after));
  assert.equal(canonicalJson(yProject.toJSON()), canonicalJson(after));
  assert.ok(updates.length <= 1, "all changes must be a single update (one transaction)");

  // A remote replica that applies the update sees exactly the same project.
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  assert.equal(canonicalJson(replica.getMap("root").get("projects").get(0).toJSON()), canonicalJson(after));
  return { doc, yProject, updates };
};

test("sync: edits, deletions, reorders, type changes converge exactly", () => {
  const before = base();
  const cases = [];

  let p = clone(before); p.title = "Renamed"; cases.push(p);
  p = clone(before); delete p.titlePlaceholder; delete p.fields; p.info.description = "x"; cases.push(p);
  p = clone(before); p.tasks.reverse(); cases.push(p);
  p = clone(before); p.tasks.splice(1, 1); p.tasks.push({ id: "new-task", text: "n", completed: false, group: p.groups[0].id }); cases.push(p);
  p = clone(before); p.tasks = p.tasks.map(({ id, ...rest }) => (void id, rest)); cases.push(p); // id-less tasks
  p = clone(before); p.template = null; cases.push(p);
  p = clone(before); p.fields = { a: "1", b: "2" }; cases.push(p);
  p = clone(before); p.groups = []; p.tasks = []; cases.push(p);
  p = clone(before); p.noteCollections[0].items.unshift({ id: "n0", text: "t", projectId: p.id, notesId: p.noteCollections[0].id }); cases.push(p);
  cases.push(clone(presets[1])); // completely different content

  for (const after of cases) {
    after.id = before.id;
    syncAndCheck(before, after);
  }
});

test("sync: unchanged nested items keep their Yjs identity", () => {
  const before = base();
  const after = clone(before);
  after.title = "Only title changed";
  const { doc, yProject } = makeDoc(before);
  const firstTask = yProject.get("tasks").get(0);
  doc.transact(() => syncYMap(yProject, after));
  assert.equal(yProject.get("tasks").get(0), firstTask);
});

test("sync: no-op sync produces no update", () => {
  const before = base();
  const { updates } = syncAndCheck(before, clone(before));
  assert.equal(updates.length, 0);
});
