import { badRequest, internalServerError, notFound, unauthorized } from "../lib/api.js";
import { readJsonBody } from "../lib/http.js";
import { MAX_MCP_TOKEN_NAME_LENGTH, normalizeMcpTokenName } from "../lib/mcpTokens.js";
import { json } from "../lib/responses.js";

const TOKEN_ITEM_RE = /^\/api\/mcp\/tokens\/([1-9][0-9]{0,8})$/;

const methodNotAllowed = (response, allow) =>
  json(response, 405, { error: "Method Not Allowed" }, { Allow: allow });

const requireMasterAuth = ({ request, response, getMasterToken, checkMasterAuth }) => {
  if (!getMasterToken()) {
    json(response, 409, { error: "Not initialized" });
  }
  if (!checkMasterAuth || !checkMasterAuth(request)) {
    unauthorized(response);
  }
};

/**
 * MCP token management (`/api/mcp/*`). Everything except `GET /api/mcp/status`
 * requires the master token.
 */
export const handleMcpAdminRequest = async ({
  request,
  response,
  pathname,
  mcpTokens,
  getMasterToken,
  checkMasterAuth,
}) => {
  if (!pathname.startsWith("/api/mcp/")) return;

  if (pathname === "/api/mcp/status") {
    if (request.method !== "GET") return methodNotAllowed(response, "GET");
    return json(response, 200, { enabled: mcpTokens.hasActive() });
  }

  if (pathname === "/api/mcp/tokens") {
    if (request.method === "GET") {
      requireMasterAuth({ request, response, getMasterToken, checkMasterAuth });
      return json(response, 200, { tokens: mcpTokens.list() });
    }

    if (request.method === "POST") {
      requireMasterAuth({ request, response, getMasterToken, checkMasterAuth });
      const body = await readJsonBody(request, response);
      const name = normalizeMcpTokenName(body?.name);
      if (name == null) {
        return badRequest(
          response,
          `Name must be a string of at most ${MAX_MCP_TOKEN_NAME_LENGTH} characters`,
        );
      }

      let issued;
      try {
        issued = mcpTokens.issue({ name });
      } catch (err) {
        console.error("MCP token issue error:", err?.message || err);
        return internalServerError(response, "Failed to create MCP token");
      }
      return json(response, 201, { token: issued.token, tokenInfo: issued.record });
    }

    return methodNotAllowed(response, "GET, POST");
  }

  const match = pathname.match(TOKEN_ITEM_RE);
  if (match) {
    if (request.method !== "DELETE") return methodNotAllowed(response, "DELETE");
    requireMasterAuth({ request, response, getMasterToken, checkMasterAuth });

    let revoked;
    try {
      revoked = mcpTokens.revoke(Number(match[1]));
    } catch (err) {
      console.error("MCP token revoke error:", err?.message || err);
      return internalServerError(response, "Failed to revoke MCP token");
    }
    if (!revoked) return notFound(response, "Token not found");
    return json(response, 200, { revoked: true });
  }
  return notFound(response, "Not Found");
};
