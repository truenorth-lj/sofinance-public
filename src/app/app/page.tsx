import { SelectedApp } from "@/components/selected-app";

export const metadata = {
  title: "Positions · SoFinance",
  description: "Choose a wallet asset and an existing Raydium CLMM position, then preview an atomic liquidity add.",
};

export default async function AppHome({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || "" : value || "";
  const view = first(query.view);
  return <SelectedApp key={`${view}:${first(query.mint) || first(query.positionMint)}:${first(query.wallet)}`} initialView={view === "performance" || view === "deposit" ? view : "compound"}
    initialMint={first(query.mint) || first(query.positionMint)} initialWallet={first(query.wallet)} previewPoolId={first(query.pool)} />;
}
