#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * stdio entry point. Nothing may be written to stdout except protocol traffic, so any
 * logging goes to stderr.
 */
async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`hk-markets-mcp ready on stdio`);
}

main().catch((err) => {
  console.error("hk-markets-mcp failed to start:", err);
  process.exit(1);
});
