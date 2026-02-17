import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server.js";

const MAX_MCP_BODY_BYTES = 1024 * 1024;

const jsonRpcError = (
  response,
  statusCode,
  code,
  message,
  extraHeaders = {},
) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
  );
  throw null;
};

const parseContentLength = (value) => {
  if (value == null) return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const drainRequestBody = (request) => {
  request.on("data", () => {});
  request.on("end", () => {});
  request.on("error", () => {});
  request.resume?.();
};

const readJsonBodyLimited = (request, maxBytes) =>
  new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];

    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > maxBytes) {
        cleanup();
        drainRequestBody(request);
        resolve({ ok: false, error: "too_large" });
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      cleanup();
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve({ ok: true, value: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, error: "invalid_json" });
      }
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const onAborted = () => {
      cleanup();
      reject(new Error("Request aborted"));
    };

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });

export const handleMcpRequest = async ({
  request,
  response,
  pathname,
  dbPath,
  appVersion,
  getToken,
  checkAuth,
}) => {
  if (pathname !== "/mcp") return;

  const enabledToken = typeof getToken === "function" ? String(getToken() || "").trim() : "";
  if (!enabledToken) {
    jsonRpcError(response, 404, -32000, "MCP is disabled");
  }

  // Stateless mode: POST only.
  if (request.method !== "POST") {
    jsonRpcError(response, 405, -32000, "Method not allowed. Use POST /mcp.", {
      Allow: "POST",
    });
  }

  // MCP streamable HTTP can keep connections open (SSE). Disable the per-socket
  // inactivity timeout for this request.
  const socket = request.socket;
  const previousSocketTimeout =
    typeof socket?.server?.timeout === "number" ? socket.server.timeout : null;
  socket?.setTimeout?.(0);

  let server;
  let transport;

  try {
    // Auth check — respond with JSON-RPC error format
    if (!checkAuth(request)) {
      jsonRpcError(response, 401, -32001, "Unauthorized", {
        "WWW-Authenticate": "Bearer",
      });
    }

    const contentLength = parseContentLength(request.headers["content-length"]);
    if (contentLength != null && contentLength > MAX_MCP_BODY_BYTES) {
      drainRequestBody(request);
      jsonRpcError(
        response,
        413,
        -32000,
        `Payload too large (max ${MAX_MCP_BODY_BYTES} bytes)`,
        { Connection: "close" },
      );
    }

    const body = await readJsonBodyLimited(request, MAX_MCP_BODY_BYTES);
    if (!body.ok) {
      if (body.error === "too_large") {
        jsonRpcError(
          response,
          413,
          -32000,
          `Payload too large (max ${MAX_MCP_BODY_BYTES} bytes)`,
          { Connection: "close" },
        );
      }
      jsonRpcError(response, 400, -32700, "Parse error: Invalid JSON");
    }

    // Ensure successful responses are not cached.
    response.setHeader("Cache-Control", "no-store");

    // Create fresh MCP server + transport per request (stateless pattern)
    server = createMcpServer({ dbPath, appVersion });
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    await transport.handleRequest(request, response, body.value);
  } catch (err) {
    if (err === null) throw null;
    console.error("MCP request error:", err);
    if (!response.headersSent) {
      jsonRpcError(response, 500, -32603, "Internal error");
    }
  } finally {
    await transport?.close?.();
    await server?.close?.();

    if (typeof previousSocketTimeout === "number") {
      socket?.setTimeout?.(previousSocketTimeout);
    }
  }
  throw null;
};
