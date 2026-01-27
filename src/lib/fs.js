import { readFile, stat } from "node:fs/promises";

export const statOrNull = async (filePath) => {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

export const readJsonOrNull = async (filePath) => {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
};
