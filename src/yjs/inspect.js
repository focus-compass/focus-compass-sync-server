import * as Y from "yjs";
import { extractYjsContent } from "./extract.js";

const toUint8Array = (data) => {
  if (!data) return new Uint8Array();
  return data instanceof Uint8Array ? data : new Uint8Array(data);
};

const getRootSharedType = (ydoc) => {
  let root = ydoc.share.get("root");
  if (!root && ydoc.share.size === 1) {
    root = Array.from(ydoc.share.values())[0];
  }
  return root ?? null;
};

export const countSharedTypes = (data) => {
  const update = toUint8Array(data);
  if (update.byteLength === 0) return 0;

  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, update);
    return ydoc.share.size;
  } catch {
    return 0;
  } finally {
    ydoc.destroy();
  }
};

export const getContent = (data) => {
  const update = toUint8Array(data);
  const ydoc = new Y.Doc();

  try {
    if (update.byteLength > 0) {
      Y.applyUpdate(ydoc, update);
    }

    const content = {};
    const sharedTypeNames = [];

    for (const [key, sharedType] of ydoc.share.entries()) {
      sharedTypeNames.push(key);
      content[key] = extractYjsContent(sharedType);
    }

    return { sharedTypeNames, content };
  } finally {
    ydoc.destroy();
  }
};

const readIdString = (val) => {
  const str = readString(val);
  if (str) return str;
  const num = readNumber(val);
  if (num != null) return String(num);
  return null;
};

const iterContainerValues = (container) => {
  if (!container) return [];
  if (Array.isArray(container)) return container;
  if (typeof container.toArray === "function") return container.toArray();
  if (typeof container.values === "function") return Array.from(container.values());
  return [];
};

export const listProjectsIndex = (data, { includeProjectInfo = false } = {}) => {
  const update = toUint8Array(data);
  const ydoc = new Y.Doc();

  try {
    if (update.byteLength > 0) {
      Y.applyUpdate(ydoc, update);
    }

    const root = getRootSharedType(ydoc);
    const projects = iterContainerValues(getProp(root, "projects"));

    const result = [];
    for (const project of projects) {
      const id = readIdString(getProp(project, "id")) ?? null;
      const title = readString(getProp(project, "title")) ?? null;
      const item = { id, title };

      if (includeProjectInfo) {
        const info = getProp(project, "info");
        item.info = {
          description: readString(getProp(info, "description")) ?? null,
          image: readString(getProp(info, "image")) ?? null,
          imageFit: readString(getProp(info, "imageFit")) ?? null,
          imageCrop: readString(getProp(info, "imageCrop")) ?? null,
        };
        item.fields = safeToJson(getProp(project, "fields")) ?? {};
      }

      result.push(item);
    }
    return result;
  } catch {
    return [];
  } finally {
    ydoc.destroy();
  }
};

export const getProjectContentById = (data, projectId) => {
  const update = toUint8Array(data);
  const ydoc = new Y.Doc();

  try {
    if (update.byteLength > 0) {
      Y.applyUpdate(ydoc, update);
    }

    const root = getRootSharedType(ydoc);
    const projects = iterContainerValues(getProp(root, "projects"));

    const availableProjects = [];
    let match = null;
    let found = false;

    for (const project of projects) {
      const id = readIdString(getProp(project, "id")) ?? null;
      const title = readString(getProp(project, "title")) ?? null;
      availableProjects.push({ id, title });

      if (id && id === projectId) {
        match = project;
        found = true;
      }
    }

    if (!match) {
      return { found: false, project: null, availableProjects };
    }

    const extracted = extractYjsContent(match);
    return { found, project: extracted, availableProjects };
  } catch {
    return { found: false, project: null, availableProjects: [] };
  } finally {
    ydoc.destroy();
  }
};

const isObject = (val) => val !== null && typeof val === "object";

const getProp = (container, key) => {
  if (!container) return undefined;
  if (typeof container.get === "function") return container.get(key);
  if (isObject(container)) return container[key];
  return undefined;
};

const safeToJson = (val) => {
  if (!isObject(val) || typeof val.toJSON !== "function") return undefined;
  try {
    return val.toJSON();
  } catch {
    return undefined;
  }
};

const readString = (val) => {
  if (typeof val === "string") return val;
  const json = safeToJson(val);
  if (typeof json === "string") return json;
  return null;
};

const readNumber = (val) => {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  const json = safeToJson(val);
  if (typeof json === "number" && Number.isFinite(json)) return json;
  if (typeof json === "string") {
    const n = Number(json);
    if (Number.isFinite(n)) return n;
  }
  if (typeof val === "string") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

const normalizeEpochMs = (n) => {
  if (!Number.isFinite(n)) return null;
  // If it looks like epoch seconds, convert to ms.
  if (n > 0 && n < 1e12) return n * 1000;
  return n;
};

const readDateMs = (val) => {
  if (val == null) return null;
  const num = readNumber(val);
  if (num != null) return normalizeEpochMs(num);

  const str = readString(val);
  if (str) {
    const trimmed = str.trim();
    if (/^\d{10,}$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return normalizeEpochMs(n);
    }
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return ms;
  }

  return null;
};

const extractWorkspaceFromRoot = (root) => {
  const workspace = getProp(root, "workspace");
  const id = readString(getProp(workspace, "id")) || null;
  const name =
    readString(getProp(workspace, "name")) || readString(getProp(workspace, "title")) || null;

  if (!id && !name) return null;
  return { id, name };
};

const extractProjectCountFromRoot = (root) => {
  const projects = getProp(root, "projects");
  if (projects && typeof projects.length === "number") return projects.length;
  if (projects && typeof projects.size === "number") return projects.size;

  const json = safeToJson(projects);
  if (Array.isArray(json)) return json.length;
  if (isObject(json)) return Object.keys(json).length;
  return 0;
};

const extractLastUpdatedAtFromRoot = (root) => {
  let bestMs = null;
  const add = (val) => {
    const ms = readDateMs(val);
    if (ms == null) return;
    if (bestMs == null || ms > bestMs) bestMs = ms;
  };

  add(getProp(root, "exportedAt"));
  add(getProp(root, "lastUpdatedAt"));
  add(getProp(root, "updatedAt"));
  add(getProp(root, "lastModifiedAt"));
  add(getProp(root, "modifiedAt"));

  const workspace = getProp(root, "workspace");
  add(getProp(workspace, "lastUpdatedAt"));
  add(getProp(workspace, "updatedAt"));
  add(getProp(workspace, "lastModifiedAt"));
  add(getProp(workspace, "modifiedAt"));

  const projects = getProp(root, "projects");
  const iter = Array.isArray(projects)
    ? projects
    : projects && typeof projects.toArray === "function"
      ? projects.toArray()
      : projects && typeof projects.values === "function"
        ? Array.from(projects.values())
        : null;

  if (iter) {
    for (const p of iter) {
      add(getProp(p, "tasksLastModifiedAt"));
      add(getProp(p, "lastUpdatedAt"));
      add(getProp(p, "updatedAt"));
      add(getProp(p, "lastModifiedAt"));
      add(getProp(p, "modifiedAt"));
    }
  }

  return bestMs != null ? new Date(bestMs).toISOString() : null;
};

export const getWorkspaceSummary = (data) => {
  const update = toUint8Array(data);
  const ydoc = new Y.Doc();

  try {
    if (update.byteLength > 0) {
      Y.applyUpdate(ydoc, update);
    }

    const root = getRootSharedType(ydoc);
    const workspace = extractWorkspaceFromRoot(root);
    const projectCount = extractProjectCountFromRoot(root);
    const lastUpdatedAt = extractLastUpdatedAtFromRoot(root);

    return {
      sharedTypes: ydoc.share.size,
      workspace,
      projectCount,
      lastUpdatedAt,
    };
  } catch {
    return {
      sharedTypes: 0,
      workspace: null,
      projectCount: 0,
      lastUpdatedAt: null,
    };
  } finally {
    ydoc.destroy();
  }
};
