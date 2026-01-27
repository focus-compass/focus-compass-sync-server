import { timingSafeEqual } from "node:crypto";

export const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
};

export const normalizeAuthToken = (token) => {
  if (token == null) return null;
  const raw = String(token);
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return (match ? match[1] : raw).trim();
};

export const getBearerToken = (req) => normalizeAuthToken(req.headers.authorization);

// Simple, token-based auth for REST endpoints
export const checkAuth = (req, expectedToken) => {
  const token = getBearerToken(req);
  if (!token) return false;
  return safeEqual(token, expectedToken);
};
