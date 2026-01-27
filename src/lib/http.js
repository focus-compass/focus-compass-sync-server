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

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, If-None-Match"
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
