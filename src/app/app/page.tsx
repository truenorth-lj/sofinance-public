import { SelectedApp } from "@/components/selected-app";

export const metadata = {
  title: "Positions · SoFinance",
  description: "Choose a wallet asset and an existing Raydium CLMM position, then preview an atomic liquidity add.",
};

export default function AppHome() {
  return <SelectedApp />;
}
