import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SoFinance",
  description:
    "Strategy recipes for AI agents and humans. Multi-step Solana LP flows, simulated and signed once in your wallet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant" className={`h-full antialiased ${geist.className}`}>
      <body className="min-h-full flex flex-col bg-[#050505] text-neutral-100">{children}</body>
    </html>
  );
}
