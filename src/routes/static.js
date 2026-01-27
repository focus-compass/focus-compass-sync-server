import { readFile } from "node:fs/promises";
import { text } from "../lib/responses.js";

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
    if (pathname === "/" || pathname === "/index.html") {
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
