import { readFile } from "node:fs/promises";
import { text, RESPONSE_SENT } from "../lib/responses.js";

const serveHtml = async (response, filePath) => {
  const content = await readFile(filePath, "utf-8");
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(content);
  throw RESPONSE_SENT;
};

const serveTextFile = async (response, filePath, contentType = "text/plain") => {
  const content = await readFile(filePath, "utf-8");
  response.writeHead(200, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": "no-store",
  });
  response.end(content);
  throw RESPONSE_SENT;
};

/** Escape a value for safe inclusion inside double-quoted bash strings. */
const escapeForBashDoubleQuote = (value) =>
  String(value).replace(/[\\"$`!]/g, "\\$&");

const serveInstallScript = (request, response, url) => {
  const { searchParams } = url;
  const rawToken = searchParams.get("token") || "YOUR_MCP_TOKEN";
  const reqHost = request.headers.host || "localhost:8080";
  const proto = request.headers["x-forwarded-proto"] || "http";
  const rawHost = searchParams.get("host") || `${proto}://${reqHost}`;

  const token = escapeForBashDoubleQuote(rawToken);
  const host = escapeForBashDoubleQuote(rawHost);

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
  throw RESPONSE_SENT;
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
    if (error === RESPONSE_SENT) throw error;
    console.error(`Error serving ${pathname}:`, error.message);
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end("Internal Server Error");
    throw RESPONSE_SENT;
  }
};
