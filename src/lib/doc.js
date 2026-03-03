export const DEFAULT_MAX_DOC_DECODE_BYTES = 128 * 1024 * 1024;

export const toByteLength = (rawSize) => {
  const n = typeof rawSize === "bigint" ? Number(rawSize) : Number(rawSize);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export const isDocTooLargeToDecode = (binarySize, maxDocDecodeBytes) =>
  Number.isFinite(maxDocDecodeBytes) && maxDocDecodeBytes > 0 && binarySize > maxDocDecodeBytes;

export const createDocTooLargeMessage = (docName, binarySize, maxDocDecodeBytes) =>
  `Document "${docName}" is ${binarySize} bytes and exceeds MAX_DOC_DECODE_BYTES (${maxDocDecodeBytes}).`;
