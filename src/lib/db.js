import { DatabaseSync } from "node:sqlite";
import { badRequest, notFound, unauthorized } from "./api.js";
import { statOrNull } from "./fs.js";
import { safeDecodeURIComponent } from "./http.js";
import { enableSecureDelete } from "./sqlite.js";

export const MAX_DOC_NAME_LENGTH = 512;

export const requireAuth = (request, response, checkAuth) => {
  if (!checkAuth(request)) {
    unauthorized(response);
  }
};

export const withDb = (dbPath, options, fn) => {
  const db = new DatabaseSync(dbPath, options);
  try {
    if (!options?.readOnly) {
      enableSecureDelete(db);
    }
    return fn(db);
  } finally {
    db.close();
  }
};

export const decodeDocName = (encodedName, response) => {
  const docName = safeDecodeURIComponent(encodedName);
  if (docName == null || docName.length > MAX_DOC_NAME_LENGTH) {
    badRequest(response, "Invalid document name");
  }
  return docName;
};

export const ensureDbExistsOr404 = async (dbPath, response) => {
  const stats = await statOrNull(dbPath);
  if (!stats) {
    notFound(response, "Database not found");
  }
};
