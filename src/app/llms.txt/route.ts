import { buildLlmsTxt } from "@/lib/llms-txt";

/** Built once at build time and served from the CDN; no per-request work. */
export const dynamic = "force-static";

export function GET() {
  return new Response(buildLlmsTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
