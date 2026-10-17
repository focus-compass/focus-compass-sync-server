import { badRequest, internalServerError } from "../lib/api.js";
import { requireAuth, decodeDocName } from "../lib/db.js";
import { readJsonBody, safeDecodeURIComponent } from "../lib/http.js";
import { json, RESPONSE_SENT } from "../lib/responses.js";
import { validateProject } from "../yjs/projectSchema.js";
import { ProjectEditorError } from "../services/projectEditor.js";

// Projects are a few KB to a few MB (tasks, notes, image refs).
export const MAX_PROJECT_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PROJECT_ID_LENGTH = 512;

const BASE_RE = /^\/api\/admin\/documents\/([^/]+)\/projects(?:\/([^/]+)(?:\/(validate|history)(?:\/([1-9][0-9]{0,8})(?:\/(restore))?)?)?)?$/;

const methodNotAllowed = (response, allow) =>
  json(response, 405, { error: "Method Not Allowed" }, { Allow: allow });

const decodeProjectId = (encoded, response) => {
  const id = safeDecodeURIComponent(encoded);
  if (id == null || id === "" || id.length > MAX_PROJECT_ID_LENGTH) {
    badRequest(response, "Invalid project id");
  }
  return id;
};

const readBody = (request, response) => readJsonBody(request, response, MAX_PROJECT_BODY_BYTES);

const sendEditorError = (response, err) => {
  if (err instanceof ProjectEditorError) {
    return json(response, err.status, { error: err.message, ...err.details });
  }
  console.error("Project editor error:", err?.message || err);
  return internalServerError(response, "Project operation failed");
};

/**
 * Project-level read/edit API (master token):
 *   GET    /api/admin/documents/:doc/projects
 *   GET    /api/admin/documents/:doc/projects/:id
 *   PUT    /api/admin/documents/:doc/projects/:id            { baseVersion, project }
 *   PATCH  /api/admin/documents/:doc/projects/:id            { baseVersion, patch }
 *   POST   /api/admin/documents/:doc/projects/:id/validate   { project }
 *   GET    /api/admin/documents/:doc/projects/:id/history
 *   GET    /api/admin/documents/:doc/projects/:id/history/:hid
 *   POST   /api/admin/documents/:doc/projects/:id/history/:hid/restore { baseVersion }
 */
export const handleProjectsRequest = async ({ request, response, pathname, checkAuth, projectEditor }) => {
  const match = pathname.match(BASE_RE);
  if (!match) return;

  requireAuth(request, response, checkAuth);

  const [, encodedDoc, encodedProject, sub, historyIdRaw, restore] = match;
  const docName = decodeDocName(encodedDoc, response);
  const method = request.method;

  try {
    if (!encodedProject) {
      if (method !== "GET") return methodNotAllowed(response, "GET");
      return json(response, 200, { document: docName, projects: projectEditor.listProjects(docName) });
    }

    const projectId = decodeProjectId(encodedProject, response);

    if (!sub) {
      if (method === "GET") {
        return json(response, 200, projectEditor.getProject(docName, projectId));
      }
      if (method === "PUT") {
        const body = await readBody(request, response);
        if (!Object.prototype.hasOwnProperty.call(body, "project")) {
          return badRequest(response, "Body must be { baseVersion, project }");
        }
        const result = await projectEditor.saveProject({
          docName,
          projectId,
          baseVersion: body.baseVersion,
          next: body.project,
          reason: "edit",
        });
        return json(response, 200, result);
      }
      if (method === "PATCH") {
        const body = await readBody(request, response);
        const result = await projectEditor.patchProject({
          docName,
          projectId,
          baseVersion: body.baseVersion,
          patch: body.patch,
        });
        return json(response, 200, result);
      }
      return methodNotAllowed(response, "GET, PUT, PATCH");
    }

    if (sub === "validate") {
      if (method !== "POST") return methodNotAllowed(response, "POST");
      const body = await readBody(request, response);
      return json(response, 200, validateProject(body.project, { expectedId: projectId }));
    }

    // history
    if (!historyIdRaw) {
      if (method !== "GET") return methodNotAllowed(response, "GET");
      return json(response, 200, { history: projectEditor.listHistory(docName, projectId) });
    }
    const historyId = Number(historyIdRaw);
    if (!restore) {
      if (method !== "GET") return methodNotAllowed(response, "GET");
      return json(response, 200, projectEditor.getHistoryEntry(docName, projectId, historyId));
    }
    if (method !== "POST") return methodNotAllowed(response, "POST");
    const body = await readBody(request, response);
    const result = await projectEditor.restoreProject({
      docName,
      projectId,
      historyId,
      baseVersion: body.baseVersion,
    });
    return json(response, 200, result);
  } catch (err) {
    if (err === RESPONSE_SENT) throw err;
    return sendEditorError(response, err);
  }
};

