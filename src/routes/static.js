import { readFile } from "node:fs/promises";
import { text } from "../lib/responses.js";

const serveHtml = async (response, filePath) => {
  const content = await readFile(filePath, "utf-8");
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(content);
  throw null;
};

const serveTextFile = async (response, filePath, contentType = "text/plain") => {
  const content = await readFile(filePath, "utf-8");
  response.writeHead(200, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": "no-store",
  });
  response.end(content);
  throw null;
};

export const handleStaticRequest = async ({
  request,
  response,
  pathname,
  indexFilePath,
  mcpSkillFilePath,
}) => {
  // --- Static pages ---
  if (request.method !== "GET") {
    text(response, 404, "Not Found");
  }

  try {
    if (pathname === "/" || pathname === "/index.html") {
      await serveHtml(response, indexFilePath);
    }

    if (pathname === "/focus-compass-skill.md") {
      await serveTextFile(response, mcpSkillFilePath, "text/markdown");
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
