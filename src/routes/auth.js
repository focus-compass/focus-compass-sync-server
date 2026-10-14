import { getBearerToken } from "../lib/auth.js";
import { badRequest, internalServerError, unauthorized } from "../lib/api.js";
import { readJsonBody } from "../lib/http.js";
import { normalizeTokenName, MAX_TOKEN_NAME_LENGTH, TOKEN_RE } from "../lib/tokenStore.js";
import { json } from "../lib/responses.js";

export const handleAuthRequest = async ({
  request,
  response,
  pathname,
  tokenStore,
  checkAuth,
  envManaged,
  appVersion = "",
  updateRepo = "",
}) => {
  if (request.method === "GET" && pathname === "/api/auth/status") {
    return json(response, 200, {
      initialized: tokenStore.initialized,
      envManaged: Boolean(envManaged),
      version: String(appVersion || "").trim(),
      updateRepo: String(updateRepo || "").trim(),
    });
  }

  if (pathname === "/api/auth/setup") {
    if (request.method !== "POST") {
      return json(response, 405, { error: "Method Not Allowed" });
    }
    // Product decision: public first-visitor initialization is the intended
    // consumer onboarding flow. The initialized check and the in-memory insert
    // in tokenStore.create() run in the same tick, so setup stays one-time.
    if (tokenStore.initialized) {
      return json(response, 409, { error: "Already initialized" });
    }
    try {
      const created = await tokenStore.create({ name: "Default" });
      return json(response, 200, { token: created.token, item: created.item });
    } catch (err) {
      console.error("Auth setup error:", err);
      return json(response, 500, { error: "Failed to initialize" });
    }
  }

  if (pathname === "/api/auth/tokens") {
    if (request.method === "GET") {
      if (!tokenStore.initialized) return json(response, 409, { error: "Not initialized" });
      if (!checkAuth || !checkAuth(request)) return unauthorized(response);
      const current = tokenStore.verify(getBearerToken(request));
      return json(response, 200, { tokens: tokenStore.list(), currentId: current?.id ?? null });
    }

    if (request.method !== "POST") {
      return json(response, 405, { error: "Method Not Allowed" });
    }

    const body = await readJsonBody(request, response);
    const rawName = typeof body?.name === "string" ? body.name : "";
    if (normalizeTokenName(rawName).length > MAX_TOKEN_NAME_LENGTH) {
      return badRequest(response, `Name must be ${MAX_TOKEN_NAME_LENGTH} characters or fewer`);
    }

    if (!tokenStore.initialized) return json(response, 409, { error: "Not initialized" });
    if (!checkAuth || !checkAuth(request)) return unauthorized(response);

    try {
      const created = await tokenStore.create({ name: rawName });
      return json(response, 201, { token: created.token, item: created.item });
    } catch (err) {
      console.error("Token create error:", err);
      return internalServerError(response, "Failed to create token");
    }
  }

  const revokeMatch = pathname.match(/^\/api\/auth\/tokens\/([A-Za-z0-9_-]+)$/);
  if (revokeMatch) {
    if (request.method !== "DELETE") {
      return json(response, 405, { error: "Method Not Allowed" });
    }
    if (!tokenStore.initialized) return json(response, 409, { error: "Not initialized" });
    if (!checkAuth || !checkAuth(request)) return unauthorized(response);

    const id = revokeMatch[1];
    if (!TOKEN_RE.test(id)) return badRequest(response, "Invalid token id");

    try {
      const revoked = await tokenStore.revoke(id);
      if (!revoked) return json(response, 404, { error: "Token not found" });
    } catch (err) {
      console.error("Token revoke error:", err);
      return internalServerError(response, "Failed to revoke token");
    }
    return json(response, 200, { revoked: true });
  }
};
