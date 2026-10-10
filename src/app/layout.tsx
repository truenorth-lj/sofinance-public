import type { Metadata } from "next";
import { Geist_Mono, Host_Grotesk } from "next/font/google";
import "./globals.css";

const display = Host_Grotesk({ subsets: ["latin"], variable: "--font-grotesk" });
const data = Geist_Mono({ subsets: ["latin"], variable: "--font-mono-data" });

export const metadata: Metadata = {
  title: "SoFinance",
  description:
    "Strategy recipes for AI agents and humans. Multi-step Solana LP flows, simulated and signed once in your wallet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`h-full antialiased ${display.variable} ${data.variable} font-display`}>
      <body className="min-h-full flex flex-col bg-canvas text-cream">{children}</body>
    </html>
  );
}
