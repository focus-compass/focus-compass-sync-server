import { json } from "./responses.js";

const BEARER_AUTH_HEADER = { "WWW-Authenticate": "Bearer" };

export const unauthorized = (response) =>
  json(response, 401, { error: "Unauthorized" }, BEARER_AUTH_HEADER);

export const badRequest = (response, message) =>
  json(response, 400, { error: message });

export const notFound = (response, message) =>
  json(response, 404, { error: message });

export const payloadTooLarge = (response, message = "File too large") =>
  json(response, 413, { error: message });

export const unsupportedMediaType = (response, message) =>
  json(response, 415, { error: message });

export const internalServerError = (response, message) =>
  json(response, 500, { error: message });
