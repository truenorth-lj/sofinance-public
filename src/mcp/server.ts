#!/usr/bin/env node
// Must stay the first import: lets the Next.js "server-only" guard load in a
// plain Node process, so `npx tsx src/mcp/server.ts` works without NODE_OPTIONS.
import "./server-only-mock.js";
import { listToolDefinitions } from "./tool-definitions.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

/**
 * SoFinance MCP Server
 * 
 * Provides AI agents with tools to manage Solana Raydium CLMM positions:
 * - Discover positions and assets
 * - Quote and prepare add-liquidity transactions
 * - Quote and prepare compound (yield reinvestment) transactions
 * - Submit signed transactions with full re-verification
 * 
 * Safety: Server never holds private keys. All transactions are:
 * - Fully simulated before preparation
 * - Protected by HMAC permits
 * - Re-verified immediately before broadcast
 * - Subject to 1232-byte limit and price impact caps
 */

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

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Log to stderr (stdout is reserved for MCP protocol)
  // eslint-disable-next-line no-console
  console.error("SoFinance MCP server running on stdio");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error:", error);
  process.exit(1);
});
