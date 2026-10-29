import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist_Mono, Host_Grotesk } from "next/font/google";
import { AnalyticsRoot } from "@/components/analytics-root";
import { RegionNotice } from "@/components/region-notice";
import "./globals.css";

const display = Host_Grotesk({ subsets: ["latin"], variable: "--font-grotesk" });
const data = Geist_Mono({ subsets: ["latin"], variable: "--font-mono-data" });

export const metadata: Metadata = {
  title: "SoFinance",
  description:
    "Hold the stock. Collect the fees. Self-custodial: you sign every transaction in your wallet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`h-full antialiased ${display.variable} ${data.variable} font-display`}>
      <body className="min-h-full flex flex-col bg-canvas text-cream">
        <Suspense fallback={null}>
          <AnalyticsRoot />
        </Suspense>
        <RegionNotice />
        {children}
      </body>
    </html>
  );
}
