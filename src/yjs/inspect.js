import * as Y from "yjs";
import { extractYjsContent } from "./extract.js";
import { formatDescription } from "./projectFormat.js";

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

const isObject = (val) => val !== null && typeof val === "object";

const extractRoot = (ydoc) => extractYjsContent(getRootSharedType(ydoc)) ?? {};

const getProjectsFromRoot = (root) => (Array.isArray(root?.projects) ? root.projects : []);

export const listProjectsIndex = (data, { includeProjectInfo = false } = {}) => {
  const update = toUint8Array(data);
  const ydoc = new Y.Doc();

  try {
    if (update.byteLength > 0) {
      Y.applyUpdate(ydoc, update);
    }

    const root = extractRoot(ydoc);
    const projects = getProjectsFromRoot(root);
    const descriptionMode = includeProjectInfo ? "full" : "summary";

    const result = [];
    for (const project of projects) {
      const id = readIdString(getProp(project, "id")) ?? null;
      const title = readString(getProp(project, "title"));
      const description = formatDescription(
        readString(getProp(getProp(project, "info"), "description")),
        descriptionMode,
      );
      const item = {};

      if (id != null) item.id = id;
      if (title !== null) item.title = title;
      if (description) item.description = description;

      if (Object.keys(item).length > 0) {
        result.push(item);
      }
    }
    return result;
  } catch (err) {
    console.error("listProjectsIndex: failed to decode Yjs data:", err);
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

    const root = extractRoot(ydoc);
    const projects = getProjectsFromRoot(root);

    const availableProjects = [];
    let match = null;
    let found = false;

    for (const project of projects) {
      const id = readIdString(getProp(project, "id")) ?? null;
      const title = readString(getProp(project, "title"));
      const available = {};

      if (id != null) available.id = id;
      if (title !== null) available.title = title;
      if (Object.keys(available).length > 0) {
        availableProjects.push(available);
      }

      if (id && id === projectId) {
        match = project;
        found = true;
      }
    }

    if (!match) {
      return { found: false, project: null, availableProjects };
    }

    return { found, project: match, availableProjects };
  } catch (err) {
    console.error("getProjectContentById: failed to decode Yjs data:", err);
    return { found: false, project: null, availableProjects: [] };
  } finally {
    ydoc.destroy();
  }
};

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

const extractWorkspace = (root) => {
  const ws = root?.workspace;
  const id = (typeof ws?.id === "string" && ws.id) || null;
  const name =
    (typeof ws?.name === "string" && ws.name) ||
    (typeof ws?.title === "string" && ws.title) ||
    null;
  return id || name ? { id, name } : null;
};

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
    const root = extractRoot(ydoc);
    const workspace = extractWorkspace(root);
    const projectCount = getProjectsFromRoot(root).length;
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

    const root = extractRoot(ydoc);
    const workspace = extractWorkspace(root);
    const projectCount = getProjectsFromRoot(root).length;
    const lastUpdatedAt = extractLastUpdatedAt(root);

    return {
      sharedTypes: ydoc.share.size,
      workspace,
      projectCount,
      lastUpdatedAt,
    };
  } catch (err) {
    console.error("getWorkspaceSummary: failed to decode Yjs data:", err);
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
