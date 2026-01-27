import * as Y from "yjs";
import { extractYjsContent } from "./extract.js";

const toUint8Array = (data) => {
  if (!data) return new Uint8Array();
  return data instanceof Uint8Array ? data : new Uint8Array(data);
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
