import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pools · SoFinance",
  description: "Same-asset RWA liquidity pools on Solana (Raydium CLMM) and Robinhood Chain (Uniswap v4) in one list, plus the curated USDC/USDT pool.",
};

export default function RwaPairsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
