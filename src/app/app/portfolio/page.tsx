import { UnifiedApp } from "@/components/unified-pools/unified-app";
import { unifiedPoolFlags } from "@/lib/unified-pools/flags";
import { initialSelectionFromQuery } from "@/lib/unified-positions/url";

export const metadata = {
  title: "Portfolio",
  description: "Your Solana and Robinhood Chain liquidity positions, with fee compounding, Performance, Add to position and Withdraw.",
};

export default async function AppHome({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || "" : value || "";
  // Old `/app?openPool=` links are sent to /app/rwa-pairs by the /app redirect (proxy, then src/app/app/page.tsx).
  const { rhcSigning, ...flags } = unifiedPoolFlags();
  // `?position=<source>:<id>&view=` (unified positions); old `?mint=` / `?positionMint=` links still select a Solana position.
  const selection = initialSelectionFromQuery(query);
  return <UnifiedApp key={`${selection.initialView}:${selection.initialMint || selection.initialPositionKey}:${first(query.wallet)}`}
    selected={{ ...selection, initialWallet: first(query.wallet), previewPoolId: first(query.pool) }}
    flags={flags} rhcSigningEnabled={rhcSigning} />;
}
