import { serverJson } from "@/mcp/server-card";

/** The repo-root server.json (MCP registry entry), served as-is so the hosted copy cannot drift. Built at build time. */
export const dynamic = "force-static";

export function GET() {
  return Response.json(serverJson, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
