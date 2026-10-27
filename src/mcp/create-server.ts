import { listToolDefinitions } from "./tool-definitions.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  listPositionsSchema,
  quoteAddLiquiditySchema,
  prepareTransactionSchema,
  quoteCompoundSchema,
  submitSignedTransactionSchema,
  submitCompoundTransactionSchema,
  listRwaPairsSchema,
  getPositionPerformanceSchema,
  getPoolActivitySchema,
  getPositionRangeStatusSchema,
  quoteOpenPositionSchema,
  prepareOpenPositionSchema,
  prepareWithdrawSchema,
  submitWithdrawSchema,
  submitOpenPositionSchema,
} from "./schemas.js";
import { publicToolError } from "./public-tool-error.js";
import {
  listPositions,
  quoteAddLiquidity,
  prepareTransaction,
  quoteCompound,
  prepareCompoundTransaction,
  submitSignedTransaction,
  submitCompoundTransaction,
  listRwaPairs,
  getPositionPerformance,
  getPoolActivity,
  getPositionRangeStatus,
  quoteOpenPosition,
  prepareOpenPosition,
  prepareWithdraw,
  submitWithdrawTransaction,
  submitOpenPosition,
} from "./tools.js";

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
    tools: listToolDefinitions("stdio"),
  };
});

// Tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {


      case "get_position_performance": {
        const input = getPositionPerformanceSchema.parse(args ?? {});
        const result = await getPositionPerformance(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_pool_activity": {
        const input = getPoolActivitySchema.parse(args ?? {});
        const result = await getPoolActivity(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_position_range_status": {
        const input = getPositionRangeStatusSchema.parse(args ?? {});
        const result = await getPositionRangeStatus(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "list_rwa_pairs": {
        const input = listRwaPairsSchema.parse(args ?? {});
        const result = await listRwaPairs(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
      case "list_positions": {
        const input = listPositionsSchema.parse(args);
        const result = await listPositions(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "quote_add_liquidity": {
        const input = quoteAddLiquiditySchema.parse(args);
        const result = await quoteAddLiquidity(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "prepare_transaction": {
        const input = prepareTransactionSchema.parse(args);
        const result = await prepareTransaction(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "quote_compound": {
        const input = quoteCompoundSchema.parse(args);
        const result = await quoteCompound(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "prepare_compound_transaction": {
        const input = quoteCompoundSchema.parse(args);
        const result = await prepareCompoundTransaction(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "submit_signed_transaction": {
        const input = submitSignedTransactionSchema.parse(args);
        const result = await submitSignedTransaction(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "submit_compound_transaction": {
        const input = submitCompoundTransactionSchema.parse(args);
        const result = await submitCompoundTransaction(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "quote_open_position": {
        const input = quoteOpenPositionSchema.parse(args);
        const result = await quoteOpenPosition(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "prepare_withdraw": {
        const result = await prepareWithdraw(prepareWithdrawSchema.parse(args));
        return {content:[{type:"text",text:JSON.stringify(result,null,2)}]};
      }
      case "submit_withdraw": {
        const result = await submitWithdrawTransaction(submitWithdrawSchema.parse(args) as Parameters<typeof submitWithdrawTransaction>[0]);
        return {content:[{type:"text",text:JSON.stringify(result,null,2)}]};
      }

      case "prepare_open_position": {
        const input = prepareOpenPositionSchema.parse(args);
        const result = await prepareOpenPosition(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "submit_open_position": {
        const input = submitOpenPositionSchema.parse(args);
        const result = await submitOpenPosition(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
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
