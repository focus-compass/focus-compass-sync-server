export const readNumberEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

export const readBoolEnv = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
};

export const parseBool = (value, defaultValue) => {
  if (value === null || value === undefined) return defaultValue;
  const lower = String(value).trim().toLowerCase();
  if (lower === "false" || lower === "0" || lower === "no") return false;
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  return defaultValue;
};
