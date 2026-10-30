import { UnifiedApp } from "@/components/unified-pools/unified-app";
import { unifiedPoolFlags } from "@/lib/unified-pools/flags";

export const metadata = {
  title: "Pools and positions · SoFinance",
  description: "Solana and Robinhood Chain liquidity pools in one list, and your positions on both chains.",
};

export default async function AppHome({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || "" : value || "";
  const view = first(query.view);
  const { rhcSigning, ...flags } = unifiedPoolFlags();
  return <UnifiedApp key={`${view}:${first(query.mint) || first(query.positionMint)}:${first(query.wallet)}`}
    selected={{ initialView: view === "performance" || view === "deposit" ? view : "compound",
      initialMint: first(query.mint) || first(query.positionMint), initialWallet: first(query.wallet), previewPoolId: first(query.pool) }}
    flags={flags} rhcSigningEnabled={rhcSigning} deepLinkPool={first(query.openPool)} />;
}
