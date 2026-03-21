import { z } from "zod";
import { withDb } from "../lib/db.js";
import {
  DEFAULT_MAX_DOC_DECODE_BYTES,
  createDocTooLargeMessage,
  isDocTooLargeToDecode,
  toByteLength,
} from "../lib/doc.js";
import {
  getContent,
  getProjectContentById,
  getWorkspaceSummary,
  listProjectsIndex,
} from "../yjs/inspect.js";
import {
  createWorkspaceViewOptions,
  FULL_PROJECT_VIEW_OPTIONS,
} from "../yjs/viewOptions.js";
import { transformProject, transformWorkspace } from "../yjs/workspace.js";

const MAX_DOC_NAME_LENGTH = 512;
const MAX_PROJECT_ID_LENGTH = 256;

const createDocTooLargeError = (docName, binarySize, maxDocDecodeBytes) => ({
  error: createDocTooLargeMessage(docName, binarySize, maxDocDecodeBytes),
  code: "DOC_TOO_LARGE",
  dataSize: binarySize,
  maxDocDecodeBytes,
});

const toNonEmptyTrimmedStringOrNull = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const toSqliteCode = (err) => (typeof err?.code === "string" ? err.code : null);

const normalizeSqliteReadError = (err) => {
  const code = toSqliteCode(err);
  const msg = String(err?.message ?? "");
  const msgLower = msg.toLowerCase();

  if (code === "SQLITE_CANTOPEN" || msg.includes("SQLITE_CANTOPEN")) {
    return {
      code: "SQLITE_CANTOPEN",
      message: "Database not found. Start Focus Compass and sync data first, or check DB_PATH.",
    };
  }

  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    msgLower.includes("database is locked") ||
    msgLower.includes("database is busy")
  ) {
    return {
      code: code ?? "SQLITE_BUSY",
      message: "Database is busy/locked. Retry the request in a moment.",
      retryable: true,
    };
  }

  if (
    code === "SQLITE_CORRUPT" ||
    code === "SQLITE_NOTADB" ||
    msgLower.includes("file is not a database") ||
    msgLower.includes("database disk image is malformed")
  ) {
    return {
      code: code ?? "SQLITE_CORRUPT",
      message: "Database file is corrupted or not a valid SQLite database.",
    };
  }

  if (msgLower.includes("no such table") && msgLower.includes("documents")) {
    return {
      code: "SQLITE_SCHEMA",
      message: "Database schema mismatch: table 'documents' was not found.",
    };
  }

  return null;
};

const safeReadDb = (dbPath, fn) => {
  try {
    return { ok: true, value: withDb(dbPath, { readOnly: true }, fn) };
  } catch (err) {
    const normalized = normalizeSqliteReadError(err);
    if (normalized) return { ok: false, error: normalized };
    throw err;
  }
};

const textResult = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const errorResult = (error, extra = {}) => ({
  content: [{ type: "text", text: JSON.stringify({ error, ...extra }) }],
  isError: true,
});

const validateDocName = (name) => {
  const trimmed = toNonEmptyTrimmedStringOrNull(name);
  if (!trimmed) return "Document name is required";
  if (trimmed.length > MAX_DOC_NAME_LENGTH) {
    return `Document name is too long (max ${MAX_DOC_NAME_LENGTH})`;
  }
  return null;
};

const validateProjectId = (projectId) => {
  const trimmed = toNonEmptyTrimmedStringOrNull(projectId);
  if (!trimmed) return "Project ID is required";
  if (trimmed.length > MAX_PROJECT_ID_LENGTH) {
    return `Project ID is too long (max ${MAX_PROJECT_ID_LENGTH})`;
  }
  return null;
};

const documentsTableExists = (db) =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'")
      .get(),
  );

/**
 * Load and validate a single document's binary data from the DB.
 * Returns { data } on success, or { error, ...extra } on failure.
 */
const loadDocumentData = (db, docName, maxDocDecodeBytes) => {
  if (!documentsTableExists(db)) {
    return { error: "Database is empty or incompatible (missing 'documents' table)." };
  }

  const row = db
    .prepare("SELECT data, length(data) AS dataSize FROM documents WHERE name = ?")
    .get(docName);

  if (!row) return { error: `Document "${docName}" not found` };

  const dataSize = toByteLength(row.dataSize);
  if (isDocTooLargeToDecode(dataSize, maxDocDecodeBytes)) {
    return createDocTooLargeError(docName, dataSize, maxDocDecodeBytes);
  }

  return { data: row.data };
};

export const registerTools = (
  server,
  { dbPath, maxDocDecodeBytes = DEFAULT_MAX_DOC_DECODE_BYTES, docMetaCache },
) => {
  // ── list_documents ─────────────────────────────────────────────
  server.tool(
    "list_documents",
    "List all documents (workspaces) in the Focus Compass database. By default returns compact workspace summaries with project counts and timestamps; set include_summaries=false for a lighter metadata-only response.",
    {
      include_summaries: z
        .boolean()
        .optional()
        .default(true)
        .describe("Return compact workspace summaries; disable for lighter metadata only"),
    },
    async ({ include_summaries: includeSummaries = true }) => {
      const result = safeReadDb(dbPath, (db) => {
        if (!documentsTableExists(db)) return [];

        const docs = [];

        if (!includeSummaries) {
          const stmt = db.prepare("SELECT name, length(data) AS dataSize FROM documents");
          for (const row of stmt.iterate()) {
            const cached = docMetaCache?.get(row.name);
            const item = {
              name: row.name,
              projectCount: cached?.projectCount ?? 0,
              dataSize: toByteLength(row?.dataSize),
            };

            if (toNonEmptyTrimmedStringOrNull(cached?.workspaceName)) {
              item.workspace = { name: cached.workspaceName };
            }

            docs.push(item);
          }
          return docs;
        }

        const stmt = db.prepare("SELECT name, length(data) AS dataSize FROM documents");

        const dataStmt = db.prepare("SELECT data FROM documents WHERE name = ?");

        for (const row of stmt.iterate()) {
          const dataSize = toByteLength(row?.dataSize);

          if (isDocTooLargeToDecode(dataSize, maxDocDecodeBytes)) {
            const skipped = {
              name: row.name,
              dataSize,
              summarySkipped: true,
              summaryReason: "document_too_large",
            };
            docs.push(skipped);
            continue;
          }

          const dataRow = dataStmt.get(row.name);
          const summary = getWorkspaceSummary(dataRow?.data);
          const item = {
            name: row.name,
            projectCount: summary.projectCount,
            dataSize,
          };

          if (summary.workspace) item.workspace = summary.workspace;
          if (summary.lastUpdatedAt) item.lastUpdatedAt = summary.lastUpdatedAt;

          docs.push(item);
        }
        return docs;
      });

      if (!result.ok) {
        return errorResult(result.error.message, {
          code: result.error.code,
          retryable: Boolean(result.error.retryable),
        });
      }
      return textResult(result.value);
    },
  );

  // ── get_workspace ──────────────────────────────────────────────
  server.tool(
    "get_workspace",
    "Get a compact workspace overview for LLM context. By default returns each project's id, title, short description, and current focus. Use sections to include full descriptions, additional task groups, or notes.",
    {
      document: z.string().describe("Document name (from list_documents)"),
      sections: z
        .object({
          project_info: z
            .boolean()
            .optional()
            .default(false)
            .describe("Include full project descriptions instead of short summaries"),
          current_focus: z.boolean().optional().default(true).describe("Include current focus group and its tasks"),
          next_tasks: z.boolean().optional().default(false).describe("Include upcoming task groups"),
          completed_tasks: z.boolean().optional().default(false).describe("Include completed task groups"),
          notes: z.boolean().optional().default(false).describe("Include cleaned project notes"),
        })
        .optional()
        .default({}),
    },
    async ({ document: rawDocName, sections: rawSections }) => {
      const nameError = validateDocName(rawDocName);
      if (nameError) return errorResult(nameError);

      const docName = rawDocName.trim();
      const sectionFlags = createWorkspaceViewOptions(rawSections);

      const result = safeReadDb(dbPath, (db) => {
        const loaded = loadDocumentData(db, docName, maxDocDecodeBytes);
        if (loaded.error) return loaded;

        try {
          const { content } = getContent(loaded.data);
          return transformWorkspace(content, docName, sectionFlags);
        } catch (err) {
          console.error("MCP get_workspace decode error:", err);
          return { error: `Failed to decode document data: ${err.message}` };
        }
      });

      if (!result.ok) {
        return errorResult(result.error.message, {
          code: result.error.code,
          retryable: Boolean(result.error.retryable),
        });
      }
      if (result.value?.error) return errorResult(result.value.error, result.value);
      return textResult(result.value);
    },
  );

  // ── list_projects ──────────────────────────────────────────────
  server.tool(
    "list_projects",
    "List projects in a document with IDs, titles, and short descriptions for quick LLM-friendly scanning. Use get_project for full project context, task groups, and notes.",
    {
      document: z.string().describe("Document name (from list_documents)"),
      project_info: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include full project descriptions instead of short summaries"),
    },
    async ({ document: rawDocName, project_info: includeProjectInfo }) => {
      const nameError = validateDocName(rawDocName);
      if (nameError) return errorResult(nameError);

      const docName = rawDocName.trim();

      const result = safeReadDb(dbPath, (db) => {
        const loaded = loadDocumentData(db, docName, maxDocDecodeBytes);
        if (loaded.error) return loaded;

        try {
          return listProjectsIndex(loaded.data, {
            includeProjectInfo: Boolean(includeProjectInfo),
          });
        } catch (err) {
          console.error("MCP list_projects decode error:", err);
          return { error: `Failed to decode document data: ${err.message}` };
        }
      });

      if (!result.ok) {
        return errorResult(result.error.message, {
          code: result.error.code,
          retryable: Boolean(result.error.retryable),
        });
      }
      if (result.value?.error) return errorResult(result.value.error, result.value);
      return textResult(result.value);
    },
  );

  // ── get_project ────────────────────────────────────────────────
  server.tool(
    "get_project",
    "Get the full cleaned context for a single project by ID, including description, custom fields, grouped tasks, and notes. If the project_id is not found, the error includes available project IDs.",
    {
      document: z.string().describe("Document name (from list_documents)"),
      project_id: z.string().describe("Project ID (from list_projects)"),
    },
    async ({ document: rawDocName, project_id: rawProjectId }) => {
      const nameError = validateDocName(rawDocName);
      if (nameError) return errorResult(nameError);

      const projectIdError = validateProjectId(rawProjectId);
      if (projectIdError) return errorResult(projectIdError);

      const docName = rawDocName.trim();
      const projectId = rawProjectId.trim();

      const result = safeReadDb(dbPath, (db) => {
        const loaded = loadDocumentData(db, docName, maxDocDecodeBytes);
        if (loaded.error) return loaded;

        try {
          const lookup = getProjectContentById(loaded.data, projectId);
          if (!lookup?.found) {
            return {
              error: `Project "${projectId}" not found`,
              availableProjects: lookup?.availableProjects ?? [],
            };
          }

          if (!lookup.project) {
            return {
              error: "Failed to decode project data",
              availableProjects: lookup?.availableProjects ?? [],
            };
          }

          return transformProject(lookup.project, FULL_PROJECT_VIEW_OPTIONS);
        } catch (err) {
          console.error("MCP get_project decode error:", err);
          return { error: `Failed to decode document data: ${err.message}` };
        }
      });

      if (!result.ok) {
        return errorResult(result.error.message, {
          code: result.error.code,
          retryable: Boolean(result.error.retryable),
        });
      }
      if (result.value?.error) return errorResult(result.value.error, result.value);
      return textResult(result.value);
    },
  );
};
