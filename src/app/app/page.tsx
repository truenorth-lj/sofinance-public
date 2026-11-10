import { redirect } from "next/navigation";
import { RegionNotice } from "@/components/region-notice";
import { UnifiedApp } from "@/components/unified-pools/unified-app";
import { openPoolRedirect } from "@/lib/unified-pools/deep-link";
import { unifiedPoolFlags } from "@/lib/unified-pools/flags";
import { initialSelectionFromQuery } from "@/lib/unified-positions/url";

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
  const { rhcSigning, ...flags } = unifiedPoolFlags();
  // `?position=<source>:<id>&view=` (unified positions); old `?mint=` / `?positionMint=` links still select a Solana position.
  const selection = initialSelectionFromQuery(query);
  return <>
    <RegionNotice />
    <UnifiedApp key={`${selection.initialView}:${selection.initialMint || selection.initialPositionKey}:${first(query.wallet)}`}
      selected={{ ...selection, initialWallet: first(query.wallet), previewPoolId: first(query.pool) }}
      flags={flags} rhcSigningEnabled={rhcSigning} />
  </>;
}
