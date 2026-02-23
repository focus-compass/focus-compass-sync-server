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

const serveInstallScript = (request, response, url) => {
  const { searchParams } = url;
  const token = searchParams.get("token") || "YOUR_MCP_TOKEN";
  const reqHost = request.headers.host || "localhost:8080";
  const proto = request.headers["x-forwarded-proto"] || "http";
  const host = searchParams.get("host") || `${proto}://${reqHost}`;

  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `HOST="${host}"`,
    `TOKEN="${token}"`,
    "",
    "# Add MCP server",
    'claude mcp add --transport http focus-compass "$HOST/mcp" \\',
    '  --header "Authorization: Bearer $TOKEN"',
    "",
    "# Install /focus-compass skill",
    "mkdir -p ~/.claude/skills/focus-compass",
    'curl -sL "$HOST/focus-compass-skill.md" \\',
    "  -o ~/.claude/skills/focus-compass/SKILL.md",
    "",
    'echo "Done. Try: /focus-compass"',
    "",
  ].join("\n");

  response.writeHead(200, {
    "Content-Type": "text/x-shellscript; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(script);
  throw null;
};

export const handleStaticRequest = async ({
  request,
  response,
  pathname,
  url,
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

    if (pathname === "/install.sh") {
      serveInstallScript(request, response, url);
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
