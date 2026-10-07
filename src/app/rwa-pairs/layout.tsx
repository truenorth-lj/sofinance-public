import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "RWA pairs · SoFinance",
  description: "Discover Raydium CLMM same-asset RWA trading pairs filtered by Jupiter tags and xStocks whitelist.",
};

export default function RwaPairsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
