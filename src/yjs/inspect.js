import * as Y from "yjs";
import { extractYjsContent } from "./extract.js";

const toUint8Array = (data) => {
  if (!data) return new Uint8Array();
  return data instanceof Uint8Array ? data : new Uint8Array(data);
};

const getRootSharedType = (ydoc) => {
  let root = ydoc.share.get("root");
  if (!root && ydoc.share.size > 0) {
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
/** Read workspace {id, name} from a plain JS root object (post-extractYjsContent). */
const extractWorkspace = (root) => {
  const ws = root?.workspace;
  const id = (typeof ws?.id === "string" && ws.id) || null;
  const name =
    (typeof ws?.name === "string" && ws.name) ||
    (typeof ws?.title === "string" && ws.title) ||
    null;
  return id || name ? { id, name } : null;
};

/** @param {object} root - plain JS object (already extracted via extractYjsContent) */
const extractLastUpdatedAt = (root) => {
  let bestMs = null;
  const add = (val) => {
    const ms = readDateMs(val);
    if (ms == null) return;
    if (bestMs == null || ms > bestMs) bestMs = ms;
  };

  add(root?.exportedAt);
  add(root?.lastUpdatedAt);
  add(root?.updatedAt);
  add(root?.lastModifiedAt);
  add(root?.modifiedAt);

  const workspace = root?.workspace;
  add(workspace?.lastUpdatedAt);
  add(workspace?.updatedAt);
  add(workspace?.lastModifiedAt);
  add(workspace?.modifiedAt);

  const projects = Array.isArray(root?.projects) ? root.projects : [];

  for (const p of projects) {
    add(p?.tasksLastModifiedAt);
    add(p?.lastUpdatedAt);
    add(p?.updatedAt);
    add(p?.lastModifiedAt);
    add(p?.modifiedAt);
  }

  return bestMs != null ? new Date(bestMs).toISOString() : null;
};

export const getDocMetaFromYDoc = (ydoc) => {
  try {
    const root = extractYjsContent(getRootSharedType(ydoc)) ?? {};
    const workspace = extractWorkspace(root);
    const projectCount = Array.isArray(root.projects) ? root.projects.length : 0;
    return { workspaceName: workspace?.name ?? null, projectCount };
  } catch {
    return { workspaceName: null, projectCount: 0 };
  }
};

export const getWorkspaceSummary = (data) => {
  const update = toUint8Array(data);
  const ydoc = new Y.Doc();

  try {
    if (update.byteLength > 0) {
      Y.applyUpdate(ydoc, update);
    }

    const root = extractYjsContent(getRootSharedType(ydoc)) ?? {};
    const workspace = extractWorkspace(root);
    const projectCount = Array.isArray(root.projects) ? root.projects.length : 0;
    const lastUpdatedAt = extractLastUpdatedAt(root);

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
