import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import formidable from "formidable";
import { ALLOWED_IMAGE_MIME_TYPES, detectImageMimeType } from "../images/mime.js";
import {
  badRequest,
  internalServerError,
  notFound,
  payloadTooLarge,
  unauthorized,
  unsupportedMediaType,
} from "../lib/api.js";
import { cleanupFormidableFiles } from "../lib/formidable.js";
import { readJsonOrNull, statOrNull } from "../lib/fs.js";
import { json } from "../lib/responses.js";

export const IMAGE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

const requireAuth = (request, response, checkAuth) => {
  if (!checkAuth(request)) {
    unauthorized(response);
  }
};

const handleUploadImage = async ({
  request,
  response,
  uploadTmpDir,
  imagesDir,
  maxUploadBytes,
  checkAuth,
}) => {
  requireAuth(request, response, checkAuth);

  const form = formidable({
    uploadDir: uploadTmpDir,
    keepExtensions: false,
    maxFileSize:
      Number.isFinite(maxUploadBytes) && maxUploadBytes > 0
        ? maxUploadBytes
        : 10 * 1024 * 1024,
    maxFiles: 1,
    allowEmptyFiles: false,
  });

  let fields;
  let files;
  try {
    [fields, files] = await form.parse(request);
  } catch (err) {
    const message = String(err?.message ?? "").toLowerCase();
    if (
      err?.code === "ERR_FORMIDABLE_FILE_TOO_LARGE" ||
      message.includes("maxfilesize") ||
      message.includes("file too large")
    ) {
      payloadTooLarge(response);
    }
    console.error("Upload parse error:", err);
    badRequest(response, "Invalid multipart form data");
  }

  const imageId = Array.isArray(fields?.id) ? fields.id[0] : null;
  const imageFile = Array.isArray(files?.file) ? files.file[0] : null;

  if (!imageFile || typeof imageFile.filepath !== "string" || typeof imageId !== "string") {
    await cleanupFormidableFiles(files);
    badRequest(response, "Missing file or id");
  }

  if (!IMAGE_ID_RE.test(imageId)) {
    await cleanupFormidableFiles(files);
    badRequest(response, "Invalid image ID");
  }

  const tempPath = imageFile.filepath;
  const targetPath = join(imagesDir, imageId);
  const metaPath = join(imagesDir, `${imageId}.meta.json`);

  let mimeType;
  try {
    mimeType = await detectImageMimeType(tempPath);
  } catch (err) {
    await cleanupFormidableFiles(files);
    console.error("Upload sniff error:", err);
    badRequest(response, "Invalid file");
  }

  if (!mimeType || !ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    await cleanupFormidableFiles(files);
    unsupportedMediaType(response, "Unsupported image type");
  }

  try {
    await copyFile(tempPath, targetPath, fsConstants.COPYFILE_EXCL);
  } catch (err) {
    if (err?.code === "EEXIST") {
      await cleanupFormidableFiles(files);
      json(response, 200, { success: true, id: imageId, existed: true });
    }
    await cleanupFormidableFiles(files);
    console.error("Upload store error:", err);
    internalServerError(response, "Upload failed");
  } finally {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore temp cleanup errors
    }
  }

  // Best-effort metadata (used for serving Content-Type)
  try {
    await writeFile(metaPath, JSON.stringify({ mimeType }), "utf-8");
  } catch {
    // Ignore metadata write errors
  }

  json(response, 200, { success: true, id: imageId });
};

const handleListImages = async ({ request, response, imagesDir, checkAuth }) => {
  requireAuth(request, response, checkAuth);

  try {
    const entries = await readdir(imagesDir, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && IMAGE_ID_RE.test(entry.name))
      .map((entry) => entry.name);

    const images = (
      await Promise.all(
        names.map(async (name) => {
          const filePath = join(imagesDir, name);
          const stats = await statOrNull(filePath);
          if (!stats) return null;
          return { id: name, size: stats.size, modified: stats.mtime };
        })
      )
    ).filter(Boolean);

    json(response, 200, { count: images.length, images });
  } catch (err) {
    if (err === null) throw null;
    console.error("List images error:", err);
    internalServerError(response, "Failed to list images");
  }
};

const handleGetImage = async ({ request, response, pathname, imagesDir, checkAuth }) => {
  requireAuth(request, response, checkAuth);

  const imageId = pathname.slice("/api/images/".length);
  if (!IMAGE_ID_RE.test(imageId)) {
    badRequest(response, "Invalid image ID");
  }

  const filePath = join(imagesDir, imageId);
  const metaPath = join(imagesDir, `${imageId}.meta.json`);

  const fileStats = await statOrNull(filePath);
  if (!fileStats) {
    notFound(response, "Image not found");
  }

  // Prefer stored metadata, but do not blindly trust it.
  let contentType = null;
  const meta = await readJsonOrNull(metaPath);
  if (meta && typeof meta.mimeType === "string") {
    contentType = meta.mimeType;
  }

  if (!contentType || !ALLOWED_IMAGE_MIME_TYPES.has(contentType)) {
    try {
      contentType = await detectImageMimeType(filePath);
    } catch {
      contentType = null;
    }
  }

  if (!contentType || !ALLOWED_IMAGE_MIME_TYPES.has(contentType)) {
    contentType = "application/octet-stream";
  }

  const etag = `W/"${fileStats.size}-${Number(fileStats.mtimeMs)}"`;
  const ifNoneMatch = request.headers["if-none-match"];
  if (ifNoneMatch === etag) {
    response.writeHead(304, {
      ETag: etag,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    response.end();
    throw null;
  }

  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": fileStats.size,
    "Last-Modified": fileStats.mtime.toUTCString(),
    ETag: etag,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": `inline; filename="${imageId}"`,
  });

  try {
    await pipeline(createReadStream(filePath), response);
  } catch (error) {
    if (error?.code === "ERR_STREAM_PREMATURE_CLOSE" || error?.code === "ECONNRESET") {
      throw null;
    }
    console.error("Image stream error:", error);
  }

  throw null;
};

const handleDeleteImage = async ({ request, response, pathname, imagesDir, checkAuth }) => {
  requireAuth(request, response, checkAuth);

  const imageId = pathname.slice("/api/images/".length);
  if (!IMAGE_ID_RE.test(imageId)) {
    badRequest(response, "Invalid image ID");
  }

  const filePath = join(imagesDir, imageId);
  const metaPath = join(imagesDir, `${imageId}.meta.json`);

  const stats = await statOrNull(filePath);
  if (!stats) {
    notFound(response, "Image not found");
  }

  try {
    await unlink(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      notFound(response, "Image not found");
    }
    console.error("Delete image error:", err);
    internalServerError(response, "Failed to delete image");
  }

  // Best-effort metadata cleanup
  try {
    await unlink(metaPath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.error("Delete image metadata error:", err);
    }
  }

  json(response, 200, { success: true, id: imageId });
};

export const handleImagesRequest = async ({
  request,
  response,
  pathname,
  imagesDir,
  uploadTmpDir,
  maxUploadBytes,
  checkAuth,
}) => {
  if (request.method === "POST" && pathname === "/api/upload") {
    await handleUploadImage({
      request,
      response,
      uploadTmpDir,
      imagesDir,
      maxUploadBytes,
      checkAuth,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/images") {
    await handleListImages({ request, response, imagesDir, checkAuth });
    return;
  }

  if (request.method === "GET" && pathname.startsWith("/api/images/")) {
    await handleGetImage({ request, response, pathname, imagesDir, checkAuth });
    return;
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/images/")) {
    await handleDeleteImage({ request, response, pathname, imagesDir, checkAuth });
    return;
  }
};
