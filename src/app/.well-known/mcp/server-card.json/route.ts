import { buildServerCard } from "@/mcp/server-card";

/** Static MCP server card (SEP-1649 shape, as Smithery and other directories read it). Built at build time. */
export const dynamic = "force-static";

export function GET() {
  return Response.json(buildServerCard(), {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
