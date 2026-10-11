import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Position performance · SoFinance",
  description: "Realized trading-fee APR and current position value for a Raydium CLMM position NFT from on-chain facts.",
};

export default function PositionPerformanceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
