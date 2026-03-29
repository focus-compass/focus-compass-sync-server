import { randomBytes } from "node:crypto";
import { badRequest, internalServerError, unauthorized } from "../lib/api.js";
import { readJsonOrNull } from "../lib/fs.js";
import { readJsonBody } from "../lib/http.js";
import { writePrivateJsonFile } from "../lib/privateFiles.js";
import { json } from "../lib/responses.js";

const createToken = () => {
  // 24 bytes -> 32 base64url chars (no padding)
  return randomBytes(24).toString("base64url");
};

const NEW_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export const handleAuthRequest = async ({
  request,
  response,
  pathname,
  authFilePath,
  getToken,
  setToken,
  checkAuth,
  envManaged,
  appVersion = "",
  updateRepo = "",
}) => {
  if (request.method === "GET" && pathname === "/api/auth/status") {
    return json(response, 200, {
      initialized: Boolean(getToken()),
      envManaged: Boolean(envManaged),
      version: String(appVersion || "").trim(),
      updateRepo: String(updateRepo || "").trim(),
    });
  }

  if (pathname === "/api/auth/rotate") {
    if (request.method !== "POST") {
      return json(response, 405, { error: "Method Not Allowed" });
    }

    if (envManaged) {
      return json(response, 409, { error: "Token is managed by environment" });
    }

    if (!getToken()) {
      return json(response, 409, { error: "Not initialized" });
    }

    if (!checkAuth || !checkAuth(request)) {
      return unauthorized(response);
    }

    const body = await readJsonBody(request, response);
    const next = typeof body?.token === "string" ? body.token.trim() : "";
    if (!next) {
      return badRequest(response, "Token required");
    }

    if (!NEW_TOKEN_RE.test(next)) {
      return badRequest(response, "Invalid token");
    }

    const nowIso = new Date().toISOString();
    const existing = await readJsonOrNull(authFilePath);
    const createdAt = existing && typeof existing.createdAt === "string" ? existing.createdAt : nowIso;
    const payload = {
      token: next,
      createdAt,
      rotatedAt: nowIso,
    };

    try {
      await writePrivateJsonFile(authFilePath, payload);
    } catch (err) {
      console.error("Auth rotate error:", err);
      return internalServerError(response, "Failed to update token");
    }

    setToken(next);
    return json(response, 200, { token: next });
  }

  if (pathname !== "/api/auth/setup") return;

  if (request.method !== "POST") {
    return json(response, 405, { error: "Method Not Allowed" });
  }

  if (envManaged) {
    return json(response, 409, { error: "Token is managed by environment" });
  }

  if (getToken()) {
    return json(response, 409, { error: "Already initialized" });
  }

  const token = createToken();
  const payload = {
    token,
    createdAt: new Date().toISOString(),
  };

  try {
    await writePrivateJsonFile(authFilePath, payload, { flag: "wx" });
  } catch (err) {
    if (err?.code === "EEXIST") {
      const existing = await readJsonOrNull(authFilePath);
      if (existing && typeof existing.token === "string" && existing.token.trim()) {
        setToken(existing.token.trim());
      }
      return json(response, 409, { error: "Already initialized" });
    }

    console.error("Auth setup error:", err);
    return json(response, 500, { error: "Failed to initialize" });
  }

  setToken(token);
  return json(response, 200, { token });
};
