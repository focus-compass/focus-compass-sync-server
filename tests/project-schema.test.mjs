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

// --- legacy fields & stored baseline (prod v0.0.10 bug) ----------------------
const LEGACY_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "app-projects", "legacy-prod-shapes.json");
const legacyProjects = JSON.parse(readFileSync(LEGACY_FIXTURE, "utf8")).projects;
const legacyBase = () => clone(legacyProjects[0]);

test("real-shaped legacy projects open with zero errors and no legacy noise", () => {
  assert.ok(legacyProjects.length >= 2);
  for (const project of legacyProjects) {
    // What GET reports: the stored project is its own baseline.
    const result = validateProject(project, { expectedId: project.id, stored: project });
    assert.deepEqual(result.errors, [], project.id);
    assert.equal(result.ok, true);
    assert.ok(!result.warnings.some((w) => /legacy/.test(w.message)), JSON.stringify(result.warnings));
  }
});

test("every reported prod field is known and typed (no 'unknown field')", () => {
  for (const project of legacyProjects) {
    const result = validateProject(project, { expectedId: project.id });
    assert.ok(!result.errors.some((e) => e.message === "unknown field"), JSON.stringify(result.errors));
    assert.ok(result.errors.every((e) => /legacy field/.test(e.message)), JSON.stringify(result.errors));
  }
  const paths = validateProject(legacyBase()).errors.map((e) => e.path).sort();
  for (const p of [
    "project.info.monetization", "project.info.mission", "project.info.userPersona", "project.info.domains",
    "project.info.techStack", "project.info.targetAudience", "project.info.keyAspects", "project.info.isVertical",
    "project.info.notePreviewCount", "project.noteCollections[0].settings.previewCount", "project.zIndex", "project.templateId",
  ]) assert.ok(paths.includes(p), p);
});

test("edits keep stored legacy fields; their types stay strict", () => {
  const stored = legacyBase();
  const edited = clone(stored);
  edited.title = "Renamed";
  edited.tasks.reverse();
  edited.info.mission = "New mission";
  edited.zIndex = 9;
  edited.noteCollections[0].settings.previewCount = 10;
  delete edited.templateId; // dropping a legacy field is always fine
  assert.deepEqual(validateProject(edited, { expectedId: stored.id, stored }).errors, []);

  const badType = clone(stored);
  badType.zIndex = "7";
  badType.info.isVertical = "yes";
  badType.noteCollections[0].settings.previewCount = null;
  assert.deepEqual(
    validateProject(badType, { stored }).errors.map((e) => e.path).sort(),
    ["project.info.isVertical", "project.noteCollections[0].settings.previewCount", "project.zIndex"],
  );
});

test("legacy and unknown fields cannot be newly added by an edit", () => {
  const stored = clone(presets[0]);
  const edited = clone(stored);
  edited.zIndex = 1;
  edited.info.mission = "x";
  edited.noteCollections[0].settings.previewCount = 3;
  edited.colour = "red";
  edited.isNew = true;
  const result = validateProject(edited, { stored });
  assert.deepEqual(result.errors.map((e) => e.path).sort(), [
    "project.colour", "project.info.mission", "project.isNew", "project.noteCollections[0].settings.previewCount", "project.zIndex",
  ]);
  // A legacy key is matched in the same array element (by id), not anywhere.
  const twoCollections = legacyBase();
  const moved = clone(twoCollections);
  delete moved.noteCollections[0].settings.previewCount;
  delete moved.noteCollections[1].settings.previewCount;
  moved.noteCollections.push({ ...clone(moved.noteCollections[1]), id: "new-col", settings: { showDragHandle: true, previewCount: 1 } });
  assert.deepEqual(validateProject(moved, { stored: twoCollections }).errors.map((e) => e.path), ["project.noteCollections[2].settings.previewCount"]);
});

test("pre-existing unknown fields and type errors are kept only while unchanged", () => {
  const stored = clone(presets[0]);
  stored.mysteryFlag = true;
  stored.info.imageFit = "stretch";
  stored.tasks.push(clone(stored.tasks[0]));
  // GET: only warnings.
  const own = validateProject(stored, { expectedId: stored.id, stored });
  assert.equal(own.ok, true);
  assert.deepEqual(own.warnings.map((w) => w.path).sort(), ["project.info.imageFit", "project.mysteryFlag", "project.tasks[1].id"]);
  assert.ok(own.warnings.every((w) => /already stored/.test(w.message)));

  // Unrelated edit: still saveable.
  const edited = clone(stored);
  edited.title = "x";
  edited.mysteryFlag = false; // unknown key, same JSON kind
  assert.equal(validateProject(edited, { stored }).ok, true);

  // Changing a bad value to another bad value, changing an unknown key's kind,
  // or adding another duplicate is an error.
  const worse = clone(stored);
  worse.info.imageFit = "zoom";
  worse.mysteryFlag = "yes";
  worse.tasks.push(clone(worse.tasks[0]));
  assert.deepEqual(validateProject(worse, { stored }).errors.map((e) => e.path).sort(), [
    "project.info.imageFit", "project.mysteryFlag", `project.tasks[2].id`,
  ]);

  // A stored baseline never excuses an id change or a missing required field it had.
  const idChange = clone(stored); idChange.id = "other";
  assert.ok(validateProject(idChange, { expectedId: stored.id, stored }).errors.some((e) => e.path === "project.id"));
  const dropped = clone(stored); delete dropped.tasks;
  assert.ok(validateProject(dropped, { stored }).errors.some((e) => e.path === "project.tasks"));
});

test("old-era fields: notes, focusChecklist (strings or tasks), group description", () => {
  const stored = legacyBase();
  stored.notes = [{ id: "n1", text: "old note" }];
  stored.focusChecklist = ["a", { text: "b", completed: false, group: "g" }];
  stored.groupOrder = ["legacy000002"];
  assert.deepEqual(validateProject(stored, { stored }).errors, []);
  const bad = clone(stored);
  bad.focusChecklist = [1];
  assert.deepEqual(validateProject(bad, { stored }).errors.map((e) => e.path), ["project.focusChecklist[0]"]);
});

test("review fixes: transient must be unchanged, unknown containers frozen, shifted duplicates, oneOf field paths", () => {
  const stored = clone(presets[0]);
  stored.isNew = false;
  stored.extra = { a: 1 };
  stored.label = "x";
  stored.tasks.push(clone(stored.tasks[0])); // pre-existing duplicate id
  stored.focusChecklist = [{ id: "f1", text: "a", completed: "no", group: "g" }];

  // Unrelated edit that shifts the duplicate and edits a sibling field of a
  // pre-existing bad value: still saveable.
  const ok = clone(stored);
  ok.tasks.unshift({ id: "new-task", text: "n", completed: false, group: stored.tasks[0].group });
  ok.focusChecklist[0].text = "b";
  ok.label = "y"; // unknown scalar, same kind
  assert.deepEqual(validateProject(ok, { stored }).errors, []);

  const bad = clone(stored);
  bad.isNew = true; // transient changed
  bad.extra = { a: 1, b: [] }; // unknown container changed
  bad.tasks.push(clone(bad.tasks[0])); // one more duplicate than stored
  bad.focusChecklist[0].completed = "maybe"; // bad value changed
  assert.deepEqual(validateProject(bad, { stored }).errors.map((e) => e.path).sort(), [
    "project.extra", "project.focusChecklist[0].completed", "project.isNew", `project.tasks[${bad.tasks.length - 1}].id`,
  ]);
});

test("review round 2: missing required fields on a NEW element are never excused", () => {
  const stored = clone(presets[0]);
  stored.focusChecklist = [];
  delete stored.tasks[0].group; // pre-existing missing field in a stored element
  const edited = clone(stored);
  edited.focusChecklist = [{}];
  edited.tasks.push({});
  edited.noteCollections.push({ id: "c-new", name: "n", icon: "i", items: [], settings: {} });
  const paths = validateProject(edited, { stored }).errors.map((e) => e.path).sort();
  assert.deepEqual(paths, [
    "project.focusChecklist[0].completed", "project.focusChecklist[0].group", "project.focusChecklist[0].text",
    `project.noteCollections[${edited.noteCollections.length - 1}].settings.showDragHandle`,
    `project.tasks[${edited.tasks.length - 1}].completed`, `project.tasks[${edited.tasks.length - 1}].group`, `project.tasks[${edited.tasks.length - 1}].text`,
  ]);
  // The stored element's own missing field stays a warning.
  const own = validateProject(stored, { stored });
  assert.equal(own.ok, true);
  assert.ok(own.warnings.some((w) => w.path === "project.tasks[0].group"));
});
