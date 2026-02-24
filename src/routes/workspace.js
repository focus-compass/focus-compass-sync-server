import {
  internalServerError,
  notFound,
  payloadTooLarge,
} from "../lib/api.js";
import { decodeDocName, ensureDbExistsOr404, requireAuth, withDb } from "../lib/db.js";
import { json } from "../lib/responses.js";
import { getContent } from "../yjs/inspect.js";
import { transformWorkspace } from "../yjs/workspace.js";

const DEFAULT_MAX_DOC_DECODE_BYTES = 128 * 1024 * 1024;

const parseBool = (value, defaultValue) => {
  if (value === null || value === undefined) return defaultValue;
  const lower = String(value).trim().toLowerCase();
  if (lower === "false" || lower === "0" || lower === "no") return false;
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  return defaultValue;
};

const toByteLength = (rawSize) => {
  const n = typeof rawSize === "bigint" ? Number(rawSize) : Number(rawSize);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const isDocTooLargeToDecode = (binarySize, maxDocDecodeBytes) =>
  Number.isFinite(maxDocDecodeBytes) && maxDocDecodeBytes > 0 && binarySize > maxDocDecodeBytes;

const createDocTooLargeMessage = (docName, binarySize, maxDocDecodeBytes) =>
  `Document "${docName}" is ${binarySize} bytes and exceeds MAX_DOC_DECODE_BYTES (${maxDocDecodeBytes}).`;

const parseSectionFlags = (url) => ({
  projectInfo: parseBool(url.searchParams.get("project_info"), true),
  currentFocus: parseBool(url.searchParams.get("current_focus"), true),
  nextTasks: parseBool(url.searchParams.get("next_tasks"), true),
  completedTasks: parseBool(url.searchParams.get("completed_tasks"), false),
  notes: parseBool(url.searchParams.get("notes"), false),
});

export const handleWorkspaceRequest = async ({
  request,
  response,
  url,
  pathname,
  dbPath,
  checkAuth,
  maxDocDecodeBytes = DEFAULT_MAX_DOC_DECODE_BYTES,
}) => {
  const match = pathname.match(/^\/api\/workspace\/([^/]+)$/);
  if (!match) return;
  if (request.method !== "GET") return;

  requireAuth(request, response, checkAuth);

  const docName = decodeDocName(match[1], response);
  const sections = parseSectionFlags(url);

  try {
    await ensureDbExistsOr404(dbPath, response);

    withDb(dbPath, { readOnly: true }, (db) => {
      const meta = db
        .prepare("SELECT length(data) AS dataSize FROM documents WHERE name = ?")
        .get(docName);

      if (!meta) {
        notFound(response, "Document not found");
      }

      const binarySize = toByteLength(meta.dataSize);
      if (isDocTooLargeToDecode(binarySize, maxDocDecodeBytes)) {
        payloadTooLarge(
          response,
          createDocTooLargeMessage(docName, binarySize, maxDocDecodeBytes),
        );
      }

      const row = db
        .prepare("SELECT data FROM documents WHERE name = ?")
        .get(docName);

      if (!row) {
        notFound(response, "Document not found");
      }

      const { content } = getContent(row.data);
      const result = transformWorkspace(content, docName, sections);
      json(response, 200, result);
    });
  } catch (err) {
    if (err === null) throw null;
    console.error("Workspace endpoint error:", err);
    internalServerError(response, "Failed to read workspace");
  }
};
