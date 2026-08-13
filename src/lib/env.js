export const readNumberEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

export const readPositiveIntegerEnv = (name, fallback) => {
  const value = readNumberEnv(name, fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

// Reads a boolean environment variable. Strict on purpose: only the literal
// strings "true"/"false" override the fallback, so a typo never silently flips a flag.
export const readBoolEnv = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
};

// Parses a boolean from untrusted input (e.g. query strings). Lenient: also
// accepts 1/0 and yes/no, case-insensitively. Use readBoolEnv for env vars.
export const parseBool = (value, defaultValue) => {
  if (value === null || value === undefined) return defaultValue;
  const lower = String(value).trim().toLowerCase();
  if (lower === "false" || lower === "0" || lower === "no") return false;
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  return defaultValue;
};
