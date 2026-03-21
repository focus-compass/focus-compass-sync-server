export const DESCRIPTION_SUMMARY_LIMIT = 50;

export const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const isString = (value) => typeof value === "string";

export const isNonEmptyString = (value) => isString(value) && value.trim() !== "";

export const isNonEmptyObject = (value) =>
  isPlainObject(value) && Object.keys(value).length > 0;

export const sanitizeRecord = (value) => {
  if (!isPlainObject(value)) return {};

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item == null) continue;
    if (typeof item === "string" && item.trim() === "") continue;
    result[key] = item;
  }
  return result;
};

const compactWhitespace = (value) => value.replace(/\s+/g, " ").trim();

export const formatDescription = (value, mode = "summary") => {
  if (!isNonEmptyString(value)) return null;
  if (mode === "full") return value;

  const compact = compactWhitespace(value);
  if (compact.length <= DESCRIPTION_SUMMARY_LIMIT) return compact;
  return `${compact.slice(0, DESCRIPTION_SUMMARY_LIMIT).trimEnd()}...`;
};

export const getProjectDescription = (project, mode) =>
  formatDescription(project?.info?.description, mode);

export const getProjectTitle = (project) =>
  (isString(project?.title) ? project.title : null);
