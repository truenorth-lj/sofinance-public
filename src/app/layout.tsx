import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const geist = Geist({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SoFinance",
  description: "Choose a wallet asset and an existing Raydium CLMM position, then preview an atomic liquidity add.",
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant" className={`h-full antialiased ${geist.className}`}>
      <body className="min-h-full flex flex-col bg-[#050505] text-neutral-100"><Providers>{children}</Providers></body>
    </html>
  );
}
