import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

export const createMcpServer = ({ dbPath, appVersion, maxDocDecodeBytes }) => {
  const server = new McpServer({
    name: "focus-compass",
    version: appVersion || "0.0.1",
  });

  registerTools(server, { dbPath, maxDocDecodeBytes });

  return server;
};
