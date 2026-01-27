import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readJsonOrNull } from "../lib/fs.js";
import { json } from "../lib/responses.js";

const createToken = () => randomBytes(32).toString("base64url");

export const handleAuthRequest = async ({
  request,
  response,
  pathname,
  authFilePath,
  getToken,
  setToken,
  envManaged,
}) => {
  if (request.method === "GET" && pathname === "/api/auth/status") {
    json(response, 200, {
      initialized: Boolean(getToken()),
      envManaged: Boolean(envManaged),
    });
  }

  if (pathname !== "/api/auth/setup") return;

  if (request.method !== "POST") {
    json(response, 405, { error: "Method Not Allowed" });
  }

  if (envManaged) {
    json(response, 409, { error: "Token is managed by environment" });
  }

  if (getToken()) {
    json(response, 409, { error: "Already initialized" });
  }

  const token = createToken();
  const payload = {
    token,
    createdAt: new Date().toISOString(),
  };

  try {
    await mkdir(dirname(authFilePath), { recursive: true });
    await writeFile(authFilePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    if (err?.code === "EEXIST") {
      const existing = await readJsonOrNull(authFilePath);
      if (existing && typeof existing.token === "string" && existing.token.trim()) {
        setToken(existing.token.trim());
      }
      json(response, 409, { error: "Already initialized" });
    }

    console.error("Auth setup error:", err);
    json(response, 500, { error: "Failed to initialize" });
  }

  setToken(token);
  json(response, 200, { token });
};
