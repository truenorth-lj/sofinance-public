import type { Metadata } from "next";
import { Geist_Mono, Host_Grotesk } from "next/font/google";
import "./globals.css";

const display = Host_Grotesk({ subsets: ["latin"], variable: "--font-grotesk" });
const data = Geist_Mono({ subsets: ["latin"], variable: "--font-mono-data" });

export const metadata: Metadata = {
  title: "SoFinance",
  description:
    "A self-custodial tool to manage your Raydium CLMM positions. Every transaction is simulated and signed by you in your wallet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`h-full antialiased ${display.variable} ${data.variable} font-display`}>
      <body className="min-h-full flex flex-col bg-canvas text-cream">{children}</body>
    </html>
  );
}
