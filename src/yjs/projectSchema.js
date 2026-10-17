/**
 * Schema for a single Focus Compass project, as stored in the workspace Yjs
 * document (`root.projects[i]`).
 *
 * Sources:
 *   - the app's current `Project` type (focus-compass-app src/types/index.ts);
 *   - every field that type has had in the app's git history (LEGACY fields:
 *     the app stopped writing them, but its sync never deletes them, so old
 *     projects still carry them);
 *   - real preset data (tests/fixtures/app-projects).
 *
 * Strictness model (see validateProject):
 *   - Types are strict for every value the edit introduces or changes.
 *   - Unknown keys, LEGACY keys, UI-only keys and type problems that are
 *     already in the stored project are reported as warnings and may be
 *     kept unchanged: an edit can never be blocked by data it did not touch,
 *     but it cannot add new unknown/legacy keys or new type errors.
 *
 * validateProject() returns:
 *   errors   - problems introduced by this edit; the project must not be saved.
 *   warnings - referential problems the app tolerates (e.g. a task that points
 *              to a missing group) and pre-existing issues kept unchanged.
 */

/** Keys the app never persists (see TRANSIENT_KEYS in the app's yjs-utils). */
export const TRANSIENT_KEYS = Object.freeze([
  "isNew",
  "isNewlyCreated",
  "isEditingNotes",
  "isDisappearing",
]);

const MAX_REPORTED = 50;
// Hard bound on collected issues (input is already capped by the body limit).
const MAX_COLLECTED = 20_000;
const IMAGE_FITS = ["cover", "contain", "inline"];
const IMAGE_CROPS = ["top", "center", "bottom", "contain"];
const TEMPLATE_SOURCES = ["builtin", "workspace"];

// --- type builders ----------------------------------------------------------
const str = { kind: "string" };
const bool = { kind: "boolean" };
const num = { kind: "number" };
const enumOf = (values) => ({ kind: "enum", values });
const arrayOf = (item) => ({ kind: "array", item });
const recordOf = (value) => ({ kind: "record", value });
const nullable = (inner) => ({ kind: "nullable", inner });
const oneOf = (...options) => ({ kind: "oneOf", options });
/** A field the app no longer writes; allowed only if the stored project has it. */
const legacy = (inner) => ({ kind: "legacy", inner });
const strings = arrayOf(str);

/** @param {Record<string, any>} required @param {Record<string, any>} [optional] */
const object = (required, optional = {}) => ({ kind: "object", required, optional });

const POSITION = object({ x: num, y: num });

const PROJECT_INFO = object(
  { image: str },
  {
    description: str,
    imageFit: enumOf(IMAGE_FITS),
    mobileImageFit: enumOf(IMAGE_FITS),
    imageCrop: enumOf(IMAGE_CROPS),
    selectedInfoTab: str,
    isInfoTabCollapsed: bool,
    // Legacy text sections (ProjectInfo until 2026-03, replaced by
    // project.fields + templates).
    domains: legacy(str),
    mission: legacy(str),
    keyAspects: legacy(str),
    targetAudience: legacy(str),
    userPersona: legacy(str),
    monetization: legacy(str),
    techStack: legacy(str),
    // Seen in real data, never in the app's typed history: image orientation
    // flag and a notes preview size (cf. project.notePreviewLimit).
    isVertical: legacy(bool),
    notePreviewCount: legacy(num),
  },
);

const CHECKLIST = object({ id: str, name: str });

const GROUP = object(
  { id: str, checklistId: str },
  {
    notes: str,
    notesVisible: bool,
    done: bool,
    doneAt: num,
    // Legacy group labels, still read by the MCP tools (src/yjs/workspace.js).
    title: str,
    name: str,
    // Legacy group description (renamed to notes/notesVisible).
    description: legacy(str),
    descriptionVisible: legacy(bool),
    isEditingDescription: legacy(bool),
  },
);

const TASK = object({ text: str, completed: bool, group: str }, { id: str });

const NOTE_ITEM = object(
  { id: str, text: str, projectId: str, notesId: str },
  { collectionId: legacy(str) },
);

const NOTE_COLLECTION = object({
  id: str,
  name: str,
  icon: str,
  items: arrayOf(NOTE_ITEM),
  settings: object(
    { showDragHandle: bool },
    {
      fontSize: num,
      // Removed by the app's migrateProjectNoteCollectionSettings().
      customName: legacy(str),
      // Seen in real data: per-collection preview size.
      previewCount: legacy(num),
    },
  ),
});

const ADVISOR_CONFIG = object({
  id: str,
  settings: object({
    includeTitle: bool,
    infoFields: strings,
    includeCurrentFocus: bool,
    includeIncompleteTasks: bool,
    includeCompletedTasks: bool,
    noteCollections: strings,
  }),
});

const TEMPLATE_REF = object({ id: str, source: enumOf(TEMPLATE_SOURCES), version: str });

/** Pre-noteCollections project notes. */
const LEGACY_NOTE = object({ id: str, text: str }, { projectId: str });

export const PROJECT_SCHEMA = object(
  {
    id: str,
    title: str,
    info: PROJECT_INFO,
    tasks: arrayOf(TASK),
    position: POSITION,
  },
  {
    titlePlaceholder: str,
    checklists: arrayOf(CHECKLIST),
    selectedChecklistId: str,
    groups: arrayOf(GROUP),
    noteCollections: arrayOf(NOTE_COLLECTION),
    isPlacing: bool,
    isSetupPending: bool,
    startWithNewTask: bool,
    exportedAt: str,
    advisorConfigs: arrayOf(ADVISOR_CONFIG),
    editSectionsState: recordOf(bool),
    template: nullable(TEMPLATE_REF),
    fields: recordOf(str),
    tasksLastModifiedAt: num,
    tasksLastCompletedAt: num,
    notePreviewLimit: num,
    // --- legacy (Project type history) ---
    templateId: legacy(str), // replaced by `template`
    zIndex: legacy(num), // canvas stacking order (2025-12)
    notes: legacy(arrayOf(LEGACY_NOTE)), // replaced by noteCollections
    image: legacy(str), // moved to info.image
    description: legacy(str), // moved to info.description
    color: legacy(str),
    domains: legacy(str),
    mission: legacy(str),
    keyAspects: legacy(str),
    userPersona: legacy(str),
    monetization: legacy(str),
    techStack: legacy(str),
    focusChecklist: legacy(arrayOf(oneOf(str, TASK))),
    groupOrder: legacy(strings),
    slug: legacy(str),
    currentFocusGroup: legacy(str),
  },
);

// --- validation -------------------------------------------------------------
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

const typeName = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return "non-finite number";
  return typeof value;
};

const formatPath = (segs) => {
  let out = "project";
  for (const key of segs) {
    out += typeof key === "number" ? `[${key}]`
      : /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  }
  return out;
};

/**
 * Collect issues. Each issue: { segs, message, code } where code is one of
 * "type" | "missing" | "unknown" | "transient" | "legacy" | "reserved" |
 * "integrity" | "id". Codes decide how a stored baseline can excuse it.
 */
const checkType = (schema, value, segs, issues) => {
  if (issues.length >= MAX_COLLECTED) return;
  const fail = (message, code = "type") => issues.push({ segs, message, code });

  switch (schema.kind) {
    case "string":
      if (typeof value !== "string") fail(`expected string, got ${typeName(value)}`);
      return;
    case "boolean":
      if (typeof value !== "boolean") fail(`expected boolean, got ${typeName(value)}`);
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(`expected finite number, got ${typeName(value)}`);
      }
      return;
    case "enum":
      if (typeof value !== "string" || !schema.values.includes(value)) {
        fail(`expected one of ${schema.values.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(value)}`);
      }
      return;
    case "nullable":
      if (value !== null) checkType(schema.inner, value, segs, issues);
      return;
    case "legacy":
      issues.push({ segs, message: "legacy field the app no longer uses; it can be kept but not added", code: "legacy" });
      checkType(schema.inner, value, segs, issues);
      return;
    case "oneOf": {
      for (const option of schema.options) {
        const probe = [];
        checkType(option, value, segs, probe);
        if (probe.length === 0) return;
      }
      fail(`value does not match any allowed shape (got ${typeName(value)})`);
      return;
    }
    case "array":
      if (!Array.isArray(value)) {
        fail(`expected array, got ${typeName(value)}`);
        return;
      }
      value.forEach((item, i) => checkType(schema.item, item, [...segs, i], issues));
      return;
    case "record":
      if (!isPlainObject(value)) {
        fail(`expected object, got ${typeName(value)}`);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        // "__proto__" cannot survive a Yjs/JSON round-trip as a plain key.
        if (key === "__proto__") {
          issues.push({ segs: [...segs, key], message: "reserved key is not allowed", code: "reserved" });
          continue;
        }
        checkType(schema.value, item, [...segs, key], issues);
      }
      return;
    case "object": {
      if (!isPlainObject(value)) {
        fail(`expected object, got ${typeName(value)}`);
        return;
      }
      for (const key of Object.keys(schema.required)) {
        if (!Object.hasOwn(value, key)) {
          issues.push({ segs: [...segs, key], message: "required field is missing", code: "missing" });
        }
      }
      for (const [key, item] of Object.entries(value)) {
        const fieldSegs = [...segs, key];
        if (key === "__proto__") {
          issues.push({ segs: fieldSegs, message: "reserved key is not allowed", code: "reserved" });
          continue;
        }
        if (TRANSIENT_KEYS.includes(key)) {
          issues.push({ segs: fieldSegs, message: "UI-only field must not be stored", code: "transient" });
          continue;
        }
        // Own-property lookups only: keys such as "constructor" must not
        // resolve to Object.prototype members of the schema tables.
        const fieldSchema = Object.hasOwn(schema.required, key)
          ? schema.required[key]
          : Object.hasOwn(schema.optional, key) ? schema.optional[key] : undefined;
        if (!fieldSchema) {
          issues.push({ segs: fieldSegs, message: "unknown field", code: "unknown" });
          continue;
        }
        checkType(fieldSchema, item, fieldSegs, issues);
      }
      return;
    }
    default:
      throw new Error(`unknown schema kind ${schema.kind}`);
  }
};

const checkUniqueIds = (items, segs, issues) => {
  if (!Array.isArray(items)) return new Set();
  const seen = new Map();
  items.forEach((item, i) => {
    const id = item?.id;
    if (typeof id !== "string") return;
    if (id.trim() === "") {
      issues.push({ segs: [...segs, i, "id"], message: "id must not be empty", code: "integrity" });
      return;
    }
    if (seen.has(id)) {
      issues.push({ segs: [...segs, i, "id"], message: `duplicate id ${JSON.stringify(id)} (also at ${formatPath([...segs, seen.get(id)])})`, code: "integrity" });
      return;
    }
    seen.set(id, i);
  });
  return new Set(seen.keys());
};

const checkIntegrity = (project, issues, warnings) => {
  if (typeof project.id === "string" && project.id.trim() === "") {
    issues.push({ segs: ["id"], message: "id must not be empty", code: "integrity" });
  }

  const checklistIds = checkUniqueIds(project.checklists, ["checklists"], issues);
  const groupIds = checkUniqueIds(project.groups, ["groups"], issues);
  checkUniqueIds(project.tasks, ["tasks"], issues);
  checkUniqueIds(project.noteCollections, ["noteCollections"], issues);
  checkUniqueIds(project.advisorConfigs, ["advisorConfigs"], issues);

  const warn = (segs, message) => warnings.push({ path: formatPath(segs), message });

  if (Array.isArray(project.noteCollections)) {
    project.noteCollections.forEach((collection, ci) => {
      const base = ["noteCollections", ci, "items"];
      checkUniqueIds(collection?.items, base, issues);
      (Array.isArray(collection?.items) ? collection.items : []).forEach((item, ii) => {
        if (typeof item?.notesId === "string" && item.notesId !== collection.id) {
          warn([...base, ii, "notesId"], `points to ${JSON.stringify(item.notesId)}, but the item is in collection ${JSON.stringify(collection.id)}`);
        }
        if (typeof item?.projectId === "string" && item.projectId !== project.id) {
          warn([...base, ii, "projectId"], `points to ${JSON.stringify(item.projectId)}, not this project`);
        }
      });
    });
  }

  if (Array.isArray(project.tasks) && Array.isArray(project.groups)) {
    project.tasks.forEach((task, i) => {
      if (typeof task?.group === "string" && !groupIds.has(task.group)) {
        warn(["tasks", i, "group"], `group ${JSON.stringify(task.group)} does not exist`);
      }
    });
  }

  if (Array.isArray(project.groups) && Array.isArray(project.checklists)) {
    project.groups.forEach((group, i) => {
      if (typeof group?.checklistId === "string" && !checklistIds.has(group.checklistId)) {
        warn(["groups", i, "checklistId"], `checklist ${JSON.stringify(group.checklistId)} does not exist`);
      }
    });
  }

  if (typeof project.selectedChecklistId === "string" && Array.isArray(project.checklists)
    && !checklistIds.has(project.selectedChecklistId)) {
    warn(["selectedChecklistId"], `checklist ${JSON.stringify(project.selectedChecklistId)} does not exist`);
  }
};

// --- stored baseline ----------------------------------------------------------
const MISSING = Symbol("missing");

const jsonKind = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/** Canonical comparison (key order independent). */
const sameJson = (a, b) => {
  if (a === b) return true;
  if (jsonKind(a) !== jsonKind(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  if (a && typeof a === "object") {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
  }
  return false;
};

/**
 * Resolve the value at `segs` in both the edited and the stored project.
 * Array elements are matched by `id` when the edited element has one, so a
 * reorder does not make an unchanged element look new.
 */
const resolvePair = (project, stored, segs) => {
  let cur = project;
  let base = stored;
  for (const key of segs) {
    if (typeof key === "number") {
      const item = Array.isArray(cur) ? cur[key] : undefined;
      cur = item === undefined ? MISSING : item;
      if (!Array.isArray(base)) {
        base = MISSING;
      } else if (item && typeof item === "object" && typeof item.id === "string") {
        const match = base.find((b) => b && typeof b === "object" && b.id === item.id);
        base = match === undefined ? MISSING : match;
      } else {
        base = key < base.length ? base[key] : MISSING;
      }
    } else {
      cur = cur !== MISSING && isPlainObject(cur) && Object.hasOwn(cur, key) ? cur[key] : MISSING;
      base = base !== MISSING && isPlainObject(base) && Object.hasOwn(base, key) ? base[key] : MISSING;
    }
  }
  return { cur, base };
};

/** Integrity issues of the stored project, as "path\u0000message" keys. */
const storedIntegrityKeys = (stored) => {
  const keys = new Set();
  if (!isPlainObject(stored)) return keys;
  const issues = [];
  checkIntegrity(stored, issues, []);
  for (const issue of issues) keys.add(`${formatPath(issue.segs)}\u0000${issue.message}`);
  return keys;
};

/** Can this issue be kept because the stored project already has it? */
const excusedByStored = (issue, project, stored, integrityKeys) => {
  if (stored === undefined || issue.code === "id") return false;
  if (issue.code === "integrity") {
    // Duplicate/empty ids are collection-wide: excuse only the very same
    // problem at the same place in the stored project.
    return integrityKeys().has(`${formatPath(issue.segs)}\u0000${issue.message}`);
  }
  const { cur, base } = resolvePair(project, stored, issue.segs);
  switch (issue.code) {
    case "legacy":
      // The key may be kept (and edited, type-checked) if it is already stored.
      return base !== MISSING;
    case "unknown":
    case "transient":
      // Untyped: keep only if already stored with the same JSON kind.
      return base !== MISSING && cur !== MISSING && jsonKind(base) === jsonKind(cur);
    default:
      // type / missing / reserved: only while unchanged.
      return cur === MISSING ? base === MISSING : base !== MISSING && sameJson(cur, base);
  }
};

const cap = (list, noun) => {
  const shown = list.slice(0, MAX_REPORTED);
  if (list.length > MAX_REPORTED) {
    shown.push({ path: "project", message: `${list.length - MAX_REPORTED} more ${noun} not shown` });
  }
  return shown;
};

/**
 * @param {unknown} project
 * @param {{ expectedId?: string, stored?: unknown }} [options]
 *   stored: the currently stored version of this project. Issues it already
 *   has are reported as warnings instead of errors (see file header).
 * @returns {{ ok: boolean, errors: {path: string, message: string}[], warnings: {path: string, message: string}[] }}
 */
export const validateProject = (project, { expectedId, stored } = {}) => {
  const issues = [];
  const warnings = [];

  checkType(PROJECT_SCHEMA, project, [], issues);

  if (isPlainObject(project)) {
    if (expectedId != null && typeof project.id === "string" && project.id !== expectedId) {
      issues.push({ segs: ["id"], message: `id cannot be changed (expected ${JSON.stringify(expectedId)})`, code: "id" });
    }
    checkIntegrity(project, issues, warnings);
  }

  let integrity;
  const integrityKeys = () => (integrity ??= storedIntegrityKeys(stored));
  const errors = [];
  const kept = [];
  for (const issue of issues) {
    const path = formatPath(issue.segs);
    if (excusedByStored(issue, project, stored, integrityKeys)) {
      // Legacy keys that are already stored are expected; don't nag about them.
      if (issue.code !== "legacy") kept.push({ path, message: `${issue.message} (already stored; kept as is)` });
    } else {
      errors.push({ path, message: issue.message });
    }
  }

  return {
    ok: errors.length === 0,
    errors: cap(errors, "errors"),
    warnings: cap([...kept, ...warnings], "warnings"),
  };
};
