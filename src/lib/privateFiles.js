import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const HAS_POSIX_FILE_MODES = process.platform !== "win32";

const isRootPath = (path) => {
  const resolved = resolve(path);
  return resolved === dirname(resolved);
};

const shouldHardenDir = (dirPath) => {
  if (!HAS_POSIX_FILE_MODES) return false;

  const resolved = resolve(dirPath);
  if (resolved === resolve(".")) return false;
  if (isRootPath(resolved)) return false;

  return true;
};

const logPermissionWarning = (path, mode, error) => {
  const octalMode = mode.toString(8);
  console.warn(`Permission hardening skipped for ${path} (${octalMode}): ${error?.message || error}`);
};

const hardenPathMode = async (path, mode, { allowMissing = false } = {}) => {
  if (!HAS_POSIX_FILE_MODES) return;

  try {
    await chmod(path, mode);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return;
    logPermissionWarning(path, mode, error);
  }
};

export const ensurePrivateDir = async (dirPath) => {
  await mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });

  if (shouldHardenDir(dirPath)) {
    await hardenPathMode(dirPath, PRIVATE_DIR_MODE);
  }
};

export const hardenPrivateFileIfExists = async (filePath) => {
  const parentDir = dirname(filePath);
  if (shouldHardenDir(parentDir)) {
    await hardenPathMode(parentDir, PRIVATE_DIR_MODE, { allowMissing: true });
  }

  await hardenPathMode(filePath, PRIVATE_FILE_MODE, { allowMissing: true });
};

export const writePrivateJsonFile = async (filePath, payload, options = {}) => {
  const { flag } = options;
  await ensurePrivateDir(dirname(filePath));

  const writeOptions = {
    encoding: "utf-8",
    mode: PRIVATE_FILE_MODE,
  };

  if (flag) {
    writeOptions.flag = flag;
  }

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, writeOptions);
  await hardenPathMode(filePath, PRIVATE_FILE_MODE);
};
