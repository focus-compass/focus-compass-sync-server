import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { badRequest, internalServerError, unauthorized, unsupportedMediaType } from "../lib/api.js";
import { readJsonOrNull } from "../lib/fs.js";
import { json } from "../lib/responses.js";

const createToken = () => randomBytes(24).toString("base64url");

const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

const readJsonBody = async (request, response, maxBytes = 8192) => {
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (contentType && !contentType.includes("application/json")) {
    return unsupportedMediaType(response, "Expected application/json");
  }

  let total = 0;
  const chunks = [];

  try {
    for await (const chunk of request) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        return badRequest(response, "Request body too large");
      }
      chunks.push(buf);
    }
  } catch {
    return badRequest(response, "Failed to read request body");
  }

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return badRequest(response, "Invalid JSON");
  }
};

const requireMasterAuth = ({ request, response, getMasterToken, checkMasterAuth }) => {
  if (!getMasterToken()) {
    json(response, 409, { error: "Not initialized" });
  }
  if (!checkMasterAuth || !checkMasterAuth(request)) {
    unauthorized(response);
  }
};

export const handleMcpAdminRequest = async ({
  request,
  response,
  pathname,
  mcpAuthFilePath,
  getMcpToken,
  setMcpToken,
  getMasterToken,
  checkMasterAuth,
  envManaged,
}) => {
  if (request.method === "GET" && pathname === "/api/mcp/status") {
    return json(response, 200, {
      enabled: Boolean(getMcpToken()),
      envManaged: Boolean(envManaged),
    });
  }

  if (pathname === "/api/mcp/enable") {
    if (request.method !== "POST") {
      return json(response, 405, { error: "Method Not Allowed" });
    }

    if (envManaged) {
      return json(response, 409, { error: "MCP token is managed by environment" });
    }

    requireMasterAuth({ request, response, getMasterToken, checkMasterAuth });

    if (getMcpToken()) {
      return json(response, 409, { error: "Already enabled" });
    }

    const token = createToken();
    const payload = {
      token,
      createdAt: new Date().toISOString(),
    };

    try {
      await mkdir(dirname(mcpAuthFilePath), { recursive: true });
      await writeFile(mcpAuthFilePath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf-8",
        flag: "wx",
      });
    } catch (err) {
      if (err?.code === "EEXIST") {
        const existing = await readJsonOrNull(mcpAuthFilePath);
        const existingToken =
          existing && typeof existing.token === "string" ? existing.token.trim() : "";
        if (existingToken) {
          setMcpToken(existingToken);
        }
        return json(response, 409, { error: "Already enabled" });
      }

      console.error("MCP enable error:", err);
      return internalServerError(response, "Failed to enable MCP");
    }

    setMcpToken(token);
    return json(response, 200, { enabled: true, token });
  }

  if (pathname === "/api/mcp/rotate") {
    if (request.method !== "POST") {
      return json(response, 405, { error: "Method Not Allowed" });
    }

    if (envManaged) {
      return json(response, 409, { error: "MCP token is managed by environment" });
    }

    requireMasterAuth({ request, response, getMasterToken, checkMasterAuth });

    if (!getMcpToken()) {
      return json(response, 409, { error: "MCP is not enabled" });
    }

    const body = await readJsonBody(request, response);
    const candidate = typeof body?.token === "string" ? body.token.trim() : "";
    const next = candidate || createToken();

    if (!TOKEN_RE.test(next)) {
      return badRequest(response, "Invalid token");
    }

    const nowIso = new Date().toISOString();
    const existing = await readJsonOrNull(mcpAuthFilePath);
    const createdAt = existing && typeof existing.createdAt === "string" ? existing.createdAt : nowIso;

    const payload = {
      token: next,
      createdAt,
      rotatedAt: nowIso,
    };

    try {
      await mkdir(dirname(mcpAuthFilePath), { recursive: true });
      await writeFile(mcpAuthFilePath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf-8",
      });
    } catch (err) {
      console.error("MCP rotate error:", err);
      return internalServerError(response, "Failed to rotate MCP token");
    }

    setMcpToken(next);
    return json(response, 200, { token: next });
  }

  if (pathname === "/api/mcp/disable") {
    if (request.method !== "POST") {
      return json(response, 405, { error: "Method Not Allowed" });
    }

    if (envManaged) {
      return json(response, 409, { error: "MCP token is managed by environment" });
    }

    requireMasterAuth({ request, response, getMasterToken, checkMasterAuth });

    if (!getMcpToken()) {
      return json(response, 409, { error: "MCP is not enabled" });
    }

    setMcpToken("");
    try {
      await unlink(mcpAuthFilePath);
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.error("MCP disable error:", err);
        return internalServerError(response, "Failed to disable MCP");
      }
    }

    return json(response, 200, { disabled: true });
  }
};
