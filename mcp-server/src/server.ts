import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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

declare const __JOBSYNC_VERSION__: string;

const EXTRACTION_SCHEMA_URI = "prompts://extraction-schema";

export function createJobSyncServer(): Server {
  const server = new Server(
    {
      name: "jobsync-mcp",
      version: typeof __JOBSYNC_VERSION__ === "string" ? __JOBSYNC_VERSION__ : "0.0.0",
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

  return server;
}
