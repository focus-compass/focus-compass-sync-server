import {
  internalServerError,
  notFound,
  payloadTooLarge,
} from "../lib/api.js";
import { decodeDocName, ensureDbExistsOr404, requireAuth, withDb } from "../lib/db.js";
import {
  DEFAULT_MAX_DOC_DECODE_BYTES,
  createDocTooLargeMessage,
  isDocTooLargeToDecode,
  toByteLength,
} from "../lib/doc.js";
import { parseBool } from "../lib/env.js";
import { json } from "../lib/responses.js";
import { getContent } from "../yjs/inspect.js";
import { transformWorkspace } from "../yjs/workspace.js";

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
      const row = db
        .prepare("SELECT data, length(data) AS dataSize FROM documents WHERE name = ?")
        .get(docName);

      if (!row) {
        notFound(response, "Document not found");
      }

      const binarySize = toByteLength(row.dataSize);
      if (isDocTooLargeToDecode(binarySize, maxDocDecodeBytes)) {
        payloadTooLarge(
          response,
          createDocTooLargeMessage(docName, binarySize, maxDocDecodeBytes),
        );
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
