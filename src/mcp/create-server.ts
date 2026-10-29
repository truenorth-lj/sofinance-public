import { listEnabledToolDefinitions } from "./tool-availability.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { publicToolError } from "./public-tool-error.js";
import { dispatchTool } from "./dispatch.js";

export function createMcpServer() {
  const server = new Server(
    {
      name: "sofinance-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Tool definitions with comprehensive descriptions
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: listEnabledToolDefinitions("stdio"),
    };
  });

  // Tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;

      const result = await dispatchTool(name, args, { surface: "mcp-stdio" });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = publicToolError(error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
