import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const geist = Geist({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SoFinance",
  description: "Choose a wallet asset and an existing Raydium CLMM position, then preview an atomic liquidity add.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant" className={`h-full antialiased ${geist.className}`}>
      <body className="min-h-full flex flex-col bg-[#050505] text-neutral-100"><Providers>{children}</Providers></body>
    </html>
  );
}
