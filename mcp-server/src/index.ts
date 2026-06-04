#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJobSyncServer } from "./server.js";

async function main() {
  const server = createJobSyncServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("jobsync-mcp fatal error:", err);
  process.exit(1);
});
