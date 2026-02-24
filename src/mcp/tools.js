import { z } from "zod";
import { withDb } from "../lib/db.js";
import {
  getContent,
  getProjectContentById,
  getWorkspaceSummary,
  listProjectsIndex,
} from "../yjs/inspect.js";
import { transformProject, transformWorkspace } from "../yjs/workspace.js";

const MAX_DOC_NAME_LENGTH = 512;
const MAX_PROJECT_ID_LENGTH = 256;
const DEFAULT_MAX_DOC_DECODE_BYTES = 128 * 1024 * 1024;

const toByteLength = (rawSize) => {
  const n = typeof rawSize === "bigint" ? Number(rawSize) : Number(rawSize);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const isDocTooLargeToDecode = (binarySize, maxDocDecodeBytes) =>
  Number.isFinite(maxDocDecodeBytes) && maxDocDecodeBytes > 0 && binarySize > maxDocDecodeBytes;

const createDocTooLargeError = (docName, binarySize, maxDocDecodeBytes) => ({
  error: `Document "${docName}" is ${binarySize} bytes and exceeds MAX_DOC_DECODE_BYTES (${maxDocDecodeBytes}).`,
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

export const registerTools = (
  server,
  { dbPath, maxDocDecodeBytes = DEFAULT_MAX_DOC_DECODE_BYTES },
) => {
  // ── list_documents ─────────────────────────────────────────────
  server.tool(
    "list_documents",
    "List all documents (workspaces) in the Focus Compass database. By default returns lightweight metadata only; set include_summaries=true to decode workspace/project summary fields.",
    {
      include_summaries: z
        .boolean()
        .optional()
        .default(false)
        .describe("Decode workspace/project summary fields (heavier for large datasets)"),
    },
    async ({ include_summaries: includeSummaries = false }) => {
      const result = safeReadDb(dbPath, (db) => {
        if (!documentsTableExists(db)) return [];

        const docs = [];
        const stmt = db.prepare("SELECT name, length(data) AS dataSize FROM documents");

        if (!includeSummaries) {
          for (const row of stmt.iterate()) {
            docs.push({
              name: row.name,
              dataSize: toByteLength(row?.dataSize),
            });
          }
          return docs;
        }

        const dataStmt = db.prepare("SELECT data FROM documents WHERE name = ?");

        for (const row of stmt.iterate()) {
          const dataSize = toByteLength(row?.dataSize);

          if (isDocTooLargeToDecode(dataSize, maxDocDecodeBytes)) {
            docs.push({
              name: row.name,
              workspace: null,
              projectCount: null,
              lastUpdatedAt: null,
              dataSize,
              summarySkipped: true,
              summaryReason: "document_too_large",
            });
            continue;
          }

          const dataRow = dataStmt.get(row.name);
          const summary = getWorkspaceSummary(dataRow?.data);
          docs.push({
            name: row.name,
            workspace: summary.workspace,
            projectCount: summary.projectCount,
            lastUpdatedAt: summary.lastUpdatedAt,
            dataSize,
          });
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
    "Get workspace overview with projects, tasks and notes. Use the sections parameter to control which data is included and reduce response size. Requires a document name from list_documents.",
    {
      document: z.string().describe("Document name (from list_documents)"),
      sections: z
        .object({
          project_info: z.boolean().optional().default(true).describe("Include project descriptions and images"),
          current_focus: z.boolean().optional().default(true).describe("Include current focus group and its tasks"),
          next_tasks: z.boolean().optional().default(true).describe("Include tasks from upcoming groups"),
          completed_tasks: z.boolean().optional().default(false).describe("Include completed tasks"),
          notes: z.boolean().optional().default(false).describe("Include note collections"),
        })
        .optional()
        .default({}),
    },
    async ({ document: rawDocName, sections: rawSections }) => {
      const nameError = validateDocName(rawDocName);
      if (nameError) return errorResult(nameError);

      const docName = rawDocName.trim();
      const s = rawSections ?? {};
      const sectionFlags = {
        projectInfo: s.project_info ?? true,
        currentFocus: s.current_focus ?? true,
        nextTasks: s.next_tasks ?? true,
        completedTasks: s.completed_tasks ?? false,
        notes: s.notes ?? false,
      };

      const result = safeReadDb(dbPath, (db) => {
        if (!documentsTableExists(db)) {
          return { error: "Database is empty or incompatible (missing 'documents' table)." };
        }

        const meta = db
          .prepare("SELECT name, length(data) AS dataSize FROM documents WHERE name = ?")
          .get(docName);

        if (!meta) return { error: `Document "${docName}" not found` };

        const dataSize = toByteLength(meta.dataSize);
        if (isDocTooLargeToDecode(dataSize, maxDocDecodeBytes)) {
          return createDocTooLargeError(docName, dataSize, maxDocDecodeBytes);
        }

        const row = db
          .prepare("SELECT data FROM documents WHERE name = ?")
          .get(docName);

        if (!row) return { error: `Document "${docName}" not found` };

        try {
          const { content } = getContent(row.data);
          return transformWorkspace(content, docName, sectionFlags);
        } catch (err) {
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
    "List projects in a document with their IDs and titles. Use project IDs from this response to call get_project. Optionally include project descriptions, images and fields.",
    {
      document: z.string().describe("Document name (from list_documents)"),
      project_info: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include project descriptions, images and fields"),
    },
    async ({ document: rawDocName, project_info: includeProjectInfo }) => {
      const nameError = validateDocName(rawDocName);
      if (nameError) return errorResult(nameError);

      const docName = rawDocName.trim();

      const result = safeReadDb(dbPath, (db) => {
        if (!documentsTableExists(db)) {
          return { error: "Database is empty or incompatible (missing 'documents' table)." };
        }

        const meta = db
          .prepare("SELECT name, length(data) AS dataSize FROM documents WHERE name = ?")
          .get(docName);

        if (!meta) return { error: `Document "${docName}" not found` };

        const dataSize = toByteLength(meta.dataSize);
        if (isDocTooLargeToDecode(dataSize, maxDocDecodeBytes)) {
          return createDocTooLargeError(docName, dataSize, maxDocDecodeBytes);
        }

        const row = db
          .prepare("SELECT data FROM documents WHERE name = ?")
          .get(docName);

        if (!row) return { error: `Document "${docName}" not found` };

        try {
          return listProjectsIndex(row.data, {
            includeProjectInfo: Boolean(includeProjectInfo),
          });
        } catch (err) {
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
    "Get detailed info about a single project by its ID, including all tasks, focus groups, and notes. If the project_id is not found, the error includes a list of available project IDs.",
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

      const allSections = {
        projectInfo: true,
        currentFocus: true,
        nextTasks: true,
        completedTasks: true,
        notes: true,
      };

      const result = safeReadDb(dbPath, (db) => {
        if (!documentsTableExists(db)) {
          return { error: "Database is empty or incompatible (missing 'documents' table)." };
        }

        const meta = db
          .prepare("SELECT name, length(data) AS dataSize FROM documents WHERE name = ?")
          .get(docName);

        if (!meta) return { error: `Document "${docName}" not found` };

        const dataSize = toByteLength(meta.dataSize);
        if (isDocTooLargeToDecode(dataSize, maxDocDecodeBytes)) {
          return createDocTooLargeError(docName, dataSize, maxDocDecodeBytes);
        }

        const row = db
          .prepare("SELECT data FROM documents WHERE name = ?")
          .get(docName);

        if (!row) return { error: `Document "${docName}" not found` };

        try {
          const lookup = getProjectContentById(row.data, projectId);
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

          return transformProject(lookup.project, allSections);
        } catch (err) {
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
