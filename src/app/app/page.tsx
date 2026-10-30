import { redirect } from "next/navigation";
import { UnifiedApp } from "@/components/unified-pools/unified-app";
import { openPoolRedirect } from "@/lib/unified-pools/deep-link";
import { unifiedPoolFlags } from "@/lib/unified-pools/flags";

export const metadata = {
  title: "Positions",
  description: "Your Solana and Robinhood Chain liquidity positions, with fee compounding, Performance, Add to position and Withdraw.",
};

export default async function AppHome({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || "" : value || "";
  // Old `/app?openPool=` links: the pool list moved to /app/rwa-pairs (the proxy sends a real 307; this is the fallback).
  const moved = openPoolRedirect(first(query.openPool));
  if (moved) redirect(moved);
  const view = first(query.view);
  const { rhcSigning, ...flags } = unifiedPoolFlags();
  return <UnifiedApp key={`${view}:${first(query.mint) || first(query.positionMint)}:${first(query.wallet)}`}
    selected={{ initialView: view === "performance" || view === "deposit" ? view : "compound",
      initialMint: first(query.mint) || first(query.positionMint), initialWallet: first(query.wallet), previewPoolId: first(query.pool) }}
    flags={flags} rhcSigningEnabled={rhcSigning} />;
}
