// Check if value is a Yjs type that needs recursive extraction
const isYjsType = (val) =>
  val && typeof val === "object" && ("_map" in val || "_start" in val);

// Recursively extract value, handling nested Yjs types
const extractValue = (val) => (isYjsType(val) ? extractYjsContent(val) : val);

// Extract content from Yjs shared types (handles AbstractType)
export const extractYjsContent = (sharedType) => {
  if (!sharedType) return null;

  // Try standard toJSON first (works for properly typed instances)
  try {
    const json = sharedType.toJSON();
    if (json !== undefined && json !== null) {
      // For non-empty results, return them
      if (typeof json === "string") return json;
      if (Array.isArray(json) && json.length > 0) return json;
      if (typeof json === "object" && Object.keys(json).length > 0) return json;
    }
  } catch {
    // Continue to manual extraction
  }

  // Manual extraction for AbstractType instances
  // Check if it's Map-like (has _map property)
  if (sharedType._map) {
    if (sharedType._map.size === 0) return {};
    const result = {};
    for (const [mapKey, item] of sharedType._map.entries()) {
      if (!item) continue;
      // Skip deleted items
      if (item.deleted) continue;
      if (!item.content) {
        result[mapKey] = null;
        continue;
      }
      try {
        const contentArr = item.content.getContent();
        if (contentArr.length === 0) {
          result[mapKey] = null;
        } else if (contentArr.length === 1) {
          result[mapKey] = extractValue(contentArr[0]);
        } else {
          result[mapKey] = contentArr.map(extractValue);
        }
      } catch {
        result[mapKey] = null;
      }
    }
    return result;
  }

  // Check if it's Array/Text-like (has _start linked list)
  if ("_start" in sharedType) {
    // Empty array/text
    if (sharedType._start === null) return [];

    const result = [];
    let current = sharedType._start;
    while (current) {
      if (!current.deleted && current.content) {
        try {
          const contentArr = current.content.getContent();
          for (const val of contentArr) {
            result.push(extractValue(val));
          }
        } catch {
          // Skip invalid items
        }
      }
      current = current.right;
    }
    // If all items are strings (Y.Text), join them
    if (result.length > 0 && result.every((v) => typeof v === "string")) {
      return result.join("");
    }
    return result;
  }

  return null;
};
