import { listToolDefinitions } from "./tool-definitions.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { publicToolError } from "./public-tool-error.js";
import { dispatchTool } from "./dispatch.js";
import { SERVER_INFO, serverInstructions } from "./protocol.js";

export function createMcpServer() {
  const server = new Server(
    { ...SERVER_INFO },
    {
      capabilities: {
        tools: {},
      },
      instructions: serverInstructions(),
    }
  );

  // Tool definitions with comprehensive descriptions
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: listToolDefinitions("stdio"),
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
