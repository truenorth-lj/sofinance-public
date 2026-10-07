import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Position performance · SoFinance",
  description: "Holding-period return and realized fee APR for a Raydium CLMM position NFT from on-chain facts.",
};

export default function PositionPerformanceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
