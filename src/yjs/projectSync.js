import { createHash } from "node:crypto";
import * as Y from "yjs";

/** JSON with object keys sorted, so equal data always yields the same string. */
export const canonicalJson = (value) => JSON.stringify(sortKeys(value));

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
};

/** Opaque optimistic-concurrency token for a project's content. */
export const projectVersion = (project) =>
  createHash("sha256").update(canonicalJson(project)).digest("hex").slice(0, 32);

export const deepEqual = (a, b) => canonicalJson(a) === canonicalJson(b);

/**
 * Plain JSON -> Yjs types, the same shape the app writes (yjs-utils toYjs):
 * objects become Y.Map, arrays become Y.Array, primitives stay as-is.
 */
export const toYjs = (value) => {
  if (Array.isArray(value)) {
    const arr = new Y.Array();
    arr.push(value.map(toYjs));
    return arr;
  }
  if (value && typeof value === "object") {
    const map = new Y.Map();
    for (const [key, item] of Object.entries(value)) map.set(key, toYjs(item));
    return map;
  }
  return value;
};

export const fromYjs = (value) => {
  if (value instanceof Y.Map || value instanceof Y.Array) return value.toJSON();
  return value;
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const hasUniqueStringIds = (items) => {
  if (items.length === 0) return false;
  const ids = new Set();
  for (const item of items) {
    if (!isObj(item) || typeof item.id !== "string" || item.id === "" || ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
};

const itemId = (yItem) => {
  if (yItem instanceof Y.Map) {
    const id = yItem.get("id");
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
};

/**
 * Make `yMap` equal to `target` with minimal changes, keeping nested shared
 * types where possible (like the app's syncYjsMap). Must run inside a
 * transaction.
 */
export const syncYMap = (yMap, target) => {
  for (const key of Array.from(yMap.keys())) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) yMap.delete(key);
  }
  for (const [key, next] of Object.entries(target)) {
    const current = yMap.get(key);
    if (current instanceof Y.Map && isObj(next)) {
      syncYMap(current, next);
    } else if (current instanceof Y.Array && Array.isArray(next)) {
      syncYArray(current, next);
    } else if (!yMap.has(key) || !deepEqual(fromYjs(current), next)) {
      yMap.set(key, toYjs(next));
    }
  }
};

/**
 * Make `yArray` equal to `target`. Arrays of objects with unique string ids are
 * matched by id (items keep their Y.Map identity when unchanged in place);
 * anything else is replaced wholesale when it differs.
 */
export const syncYArray = (yArray, target) => {
  if (deepEqual(yArray.toJSON(), target)) return;

  const currentIds = yArray.toArray().map(itemId);
  const canMatchById = hasUniqueStringIds(target)
    && currentIds.every((id) => id !== undefined)
    && new Set(currentIds).size === currentIds.length;

  if (!canMatchById) {
    yArray.delete(0, yArray.length);
    yArray.insert(0, target.map(toYjs));
    return;
  }

  let index = 0;
  for (const next of target) {
    const current = index < yArray.length ? yArray.get(index) : undefined;
    if (itemId(current) === next.id) {
      syncYMap(current, next);
      index++;
      continue;
    }
    // Moved or new: Yjs cannot re-insert an integrated type, so a move is
    // delete + insert of a fresh copy (same as the app).
    for (let j = index + 1; j < yArray.length; j++) {
      if (itemId(yArray.get(j)) === next.id) {
        yArray.delete(j, 1);
        break;
      }
    }
    yArray.insert(index, [toYjs(next)]);
    index++;
  }
  if (index < yArray.length) yArray.delete(index, yArray.length - index);
};
