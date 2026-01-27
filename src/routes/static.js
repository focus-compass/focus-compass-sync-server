import { readFile } from "node:fs/promises";
import { text } from "../lib/responses.js";

const TOKEN_PATH_RE = /^\/[A-Za-z0-9_-]{16,256}\/?$/;

export const handleStaticRequest = async ({
  request,
  response,
  pathname,
  indexFilePath,
}) => {
  // --- Static pages ---
  if (request.method !== "GET") {
    text(response, 404, "Not Found");
  }

  try {
    if (pathname === "/" || pathname === "/index.html" || TOKEN_PATH_RE.test(pathname)) {
      const content = await readFile(indexFilePath, "utf-8");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(content);
      throw null;
    }

    text(response, 404, "Not Found");
  } catch (error) {
    if (error === null) throw null;
    console.error(`Error serving ${pathname}:`, error.message);
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end("Internal Server Error");
    throw null;
  }
};
