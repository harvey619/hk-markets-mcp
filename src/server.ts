import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HkmaClient, type ClientOptions } from "./client.js";
import { createTools } from "./tools.js";

export const NAME = "hk-markets-mcp";
export const VERSION = "0.1.0";

/**
 * Tool handlers throw on a bad date or an unreachable API. The SDK turns a thrown error
 * into an `isError` tool result, which is what a model should see: something it can read
 * and retry from, not a dead connection.
 */
export function createServer(options: ClientOptions = {}): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION });
  const client = new HkmaClient(options);
  for (const tool of createTools(client)) {
    server.registerTool(tool.name, tool.config, tool.handler as never);
  }
  return server;
}
