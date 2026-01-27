import { unlink } from "node:fs/promises";

export const cleanupFormidableFiles = async (files) => {
  if (!files || typeof files !== "object") return;

  const allFiles = [];
  for (const value of Object.values(files)) {
    if (Array.isArray(value)) {
      allFiles.push(...value);
    } else if (value) {
      allFiles.push(value);
    }
  }

  await Promise.all(
    allFiles
      .filter((file) => file && typeof file.filepath === "string")
      .map(async (file) => {
        try {
          await unlink(file.filepath);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            // Best-effort cleanup
          }
        }
      })
  );
};
