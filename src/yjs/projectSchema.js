/**
 * Strict schema for a single Focus Compass project, as stored in the
 * workspace Yjs document (`root.projects[i]`).
 *
 * Derived from the app's `Project` type (focus-compass-app src/types/index.ts)
 * and real preset data. The app strips UI-only keys (TRANSIENT_KEYS) before it
 * syncs, so those keys are rejected here too.
 *
 * validateProject() returns:
 *   errors   - structural problems (wrong types, unknown keys, duplicate ids);
 *              a project with errors must never be saved.
 *   warnings - referential problems the app tolerates (e.g. a task that points
 *              to a missing group); shown to the user before saving.
 */

/** Keys the app never persists (see TRANSIENT_KEYS in the app's yjs-utils). */
export const TRANSIENT_KEYS = Object.freeze([
  "isNew",
  "isNewlyCreated",
  "isEditingNotes",
  "isDisappearing",
]);

const MAX_ERRORS = 50;
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
  },
);

const TASK = object({ text: str, completed: bool, group: str }, { id: str });

const NOTE_ITEM = object({ id: str, text: str, projectId: str, notesId: str });

const NOTE_COLLECTION = object({
  id: str,
  name: str,
  icon: str,
  items: arrayOf(NOTE_ITEM),
  settings: object({ showDragHandle: bool }, { fontSize: num }),
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

const joinPath = (base, key) =>
  typeof key === "number" ? `${base}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;

const checkType = (schema, value, path, errors) => {
  if (errors.length >= MAX_ERRORS) return;
  const fail = (message) => errors.push({ path, message });

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
      if (value !== null) checkType(schema.inner, value, path, errors);
      return;
    case "array":
      if (!Array.isArray(value)) {
        fail(`expected array, got ${typeName(value)}`);
        return;
      }
      value.forEach((item, i) => checkType(schema.item, item, joinPath(path, i), errors));
      return;
    case "record":
      if (!isPlainObject(value)) {
        fail(`expected object, got ${typeName(value)}`);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        // "__proto__" cannot survive a Yjs/JSON round-trip as a plain key.
        if (key === "__proto__") {
          errors.push({ path: joinPath(path, key), message: "reserved key is not allowed" });
          continue;
        }
        checkType(schema.value, item, joinPath(path, key), errors);
      }
      return;
    case "object": {
      if (!isPlainObject(value)) {
        fail(`expected object, got ${typeName(value)}`);
        return;
      }
      for (const key of Object.keys(schema.required)) {
        if (!Object.hasOwn(value, key)) errors.push({ path: joinPath(path, key), message: "required field is missing" });
      }
      for (const [key, item] of Object.entries(value)) {
        const fieldPath = joinPath(path, key);
        if (TRANSIENT_KEYS.includes(key)) {
          errors.push({ path: fieldPath, message: "UI-only field must not be stored" });
          continue;
        }
        // Own-property lookups only: keys such as "constructor" or "__proto__"
        // must not resolve to Object.prototype members of the schema tables.
        const fieldSchema = Object.hasOwn(schema.required, key)
          ? schema.required[key]
          : Object.hasOwn(schema.optional, key) ? schema.optional[key] : undefined;
        if (!fieldSchema) {
          errors.push({ path: fieldPath, message: "unknown field" });
          continue;
        }
        checkType(fieldSchema, item, fieldPath, errors);
      }
      return;
    }
    default:
      throw new Error(`unknown schema kind ${schema.kind}`);
  }
};

const checkUniqueIds = (items, path, errors) => {
  if (!Array.isArray(items)) return new Set();
  const seen = new Map();
  items.forEach((item, i) => {
    const id = item?.id;
    if (typeof id !== "string") return;
    if (id.trim() === "") {
      errors.push({ path: `${path}[${i}].id`, message: "id must not be empty" });
      return;
    }
    if (seen.has(id)) {
      errors.push({ path: `${path}[${i}].id`, message: `duplicate id ${JSON.stringify(id)} (also at ${path}[${seen.get(id)}])` });
      return;
    }
    seen.set(id, i);
  });
  return new Set(seen.keys());
};

const checkIntegrity = (project, errors, warnings) => {
  const p = "project";
  if (typeof project.id === "string" && project.id.trim() === "") {
    errors.push({ path: `${p}.id`, message: "id must not be empty" });
  }

  const checklistIds = checkUniqueIds(project.checklists, `${p}.checklists`, errors);
  const groupIds = checkUniqueIds(project.groups, `${p}.groups`, errors);
  checkUniqueIds(project.tasks, `${p}.tasks`, errors);
  checkUniqueIds(project.noteCollections, `${p}.noteCollections`, errors);
  checkUniqueIds(project.advisorConfigs, `${p}.advisorConfigs`, errors);

  if (Array.isArray(project.noteCollections)) {
    project.noteCollections.forEach((collection, ci) => {
      const base = `${p}.noteCollections[${ci}]`;
      checkUniqueIds(collection?.items, `${base}.items`, errors);
      (Array.isArray(collection?.items) ? collection.items : []).forEach((item, ii) => {
        if (typeof item?.notesId === "string" && item.notesId !== collection.id) {
          warnings.push({ path: `${base}.items[${ii}].notesId`, message: `points to ${JSON.stringify(item.notesId)}, but the item is in collection ${JSON.stringify(collection.id)}` });
        }
        if (typeof item?.projectId === "string" && item.projectId !== project.id) {
          warnings.push({ path: `${base}.items[${ii}].projectId`, message: `points to ${JSON.stringify(item.projectId)}, not this project` });
        }
      });
    });
  }

  if (Array.isArray(project.tasks) && Array.isArray(project.groups)) {
    project.tasks.forEach((task, i) => {
      if (typeof task?.group === "string" && !groupIds.has(task.group)) {
        warnings.push({ path: `${p}.tasks[${i}].group`, message: `group ${JSON.stringify(task.group)} does not exist` });
      }
    });
  }

  if (Array.isArray(project.groups) && Array.isArray(project.checklists)) {
    project.groups.forEach((group, i) => {
      if (typeof group?.checklistId === "string" && !checklistIds.has(group.checklistId)) {
        warnings.push({ path: `${p}.groups[${i}].checklistId`, message: `checklist ${JSON.stringify(group.checklistId)} does not exist` });
      }
    });
  }

  if (typeof project.selectedChecklistId === "string" && Array.isArray(project.checklists)
    && !checklistIds.has(project.selectedChecklistId)) {
    warnings.push({ path: `${p}.selectedChecklistId`, message: `checklist ${JSON.stringify(project.selectedChecklistId)} does not exist` });
  }
};

/**
 * @param {unknown} project
 * @param {{ expectedId?: string }} [options]
 * @returns {{ ok: boolean, errors: {path: string, message: string}[], warnings: {path: string, message: string}[] }}
 */
export const validateProject = (project, { expectedId } = {}) => {
  const errors = [];
  const warnings = [];

  checkType(PROJECT_SCHEMA, project, "project", errors);

  if (isPlainObject(project)) {
    if (expectedId != null && typeof project.id === "string" && project.id !== expectedId) {
      errors.push({ path: "project.id", message: `id cannot be changed (expected ${JSON.stringify(expectedId)})` });
    }
    checkIntegrity(project, errors, warnings);
  }

  const truncated = errors.length > MAX_ERRORS;
  const shown = errors.slice(0, MAX_ERRORS);
  if (truncated) shown.push({ path: "project", message: "too many errors; fix the ones above first" });
  return { ok: errors.length === 0, errors: shown, warnings };
};
