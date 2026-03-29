import { badRequest, unsupportedMediaType } from "./api.js";

export const readJsonBody = async (request, response, maxBytes = 8192) => {
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

export const createCorsPolicy = (rawValue) => {
  const allowOrigins = String(rawValue ?? "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const allowAny = allowOrigins.includes("*");
  const allowSet = new Set(allowOrigins.filter((origin) => origin !== "*"));

  return { allowAny, allowSet };
};

// Configurable CORS headers (default: '*')
export const setCorsHeaders = (req, res, corsPolicy) => {
  const { allowAny, allowSet } = corsPolicy;
  const origin = req.headers.origin;

  if (allowAny) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowSet.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, If-None-Match, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
};

export const setSecurityHeaders = (res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"
  );
};

export const parseRequestUrl = (request) => {
  try {
    return new URL(request.url ?? "/", "http://localhost");
  } catch {
    return null;
  }
};

export const safeDecodeURIComponent = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};
