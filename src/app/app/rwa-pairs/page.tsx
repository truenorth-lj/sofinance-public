import { redirect } from "next/navigation";
import { rwaPairsRedirect } from "@/lib/unified-pools/deep-link";

/**
 * Retired (PM 2026-10-30): the RWA pairs are in the `/app` pool list. `src/proxy.ts` sends the real 307
 * (`/app/rwa-pairs?pool=<id>&open=1` → `/app?openPool=<id>#pools`, otherwise `/app#pools`); this page is the fallback.
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function RwaPairsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") query.set(key, first);
  }
  redirect(rwaPairsRedirect(query));
}
