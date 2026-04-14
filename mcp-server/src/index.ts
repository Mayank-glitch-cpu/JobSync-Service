#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { EXTRACTION_SYSTEM_PROMPT } from "./lib/extraction-prompt.js";
import { registerPrompts } from "./prompts/index.js";
import { registerTools } from "./tools/index.js";

const EXTRACTION_SCHEMA_URI = "prompts://extraction-schema";

async function main() {
  const server = new Server(
    {
      name: "jobsync-mcp",
      version: "0.2.6",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    },
  );

  const tools = registerTools();
  const prompts = registerPrompts();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    const result = await tool.handler(request.params.arguments ?? {});
    return result as unknown as {
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = prompts.find((p) => p.name === request.params.name);
    if (!prompt) {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    const args = (request.params.arguments ?? {}) as Record<string, string>;
    return {
      description: prompt.description,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: prompt.render(args) },
        },
      ],
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: EXTRACTION_SCHEMA_URI,
        name: "Job extraction schema",
        description:
          "System prompt + JSON schema for extracting structured fields from a job posting (workModel, industry, h1bSponsored, isNewGrad, datePosted, qualifications, salary, confidence). Use as the system message when asking a model to structure a raw posting.",
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== EXTRACTION_SCHEMA_URI) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
    return {
      contents: [
        {
          uri: EXTRACTION_SCHEMA_URI,
          mimeType: "text/plain",
          text: EXTRACTION_SYSTEM_PROMPT,
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("jobsync-mcp fatal error:", err);
  process.exit(1);
});
