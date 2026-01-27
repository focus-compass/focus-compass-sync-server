import { open } from "node:fs/promises";

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const detectImageMimeType = async (filePath) => {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);

    // PNG
    if (
      header.length >= 8 &&
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47 &&
      header[4] === 0x0d &&
      header[5] === 0x0a &&
      header[6] === 0x1a &&
      header[7] === 0x0a
    ) {
      return "image/png";
    }

    // JPEG
    if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
      return "image/jpeg";
    }

    // GIF
    if (header.length >= 6) {
      const signature = header.toString("ascii", 0, 6);
      if (signature === "GIF87a" || signature === "GIF89a") {
        return "image/gif";
      }
    }

    // WebP
    if (header.length >= 12) {
      const riff = header.toString("ascii", 0, 4);
      const webp = header.toString("ascii", 8, 12);
      if (riff === "RIFF" && webp === "WEBP") {
        return "image/webp";
      }
    }

    return null;
  } finally {
    await handle.close();
  }
};
