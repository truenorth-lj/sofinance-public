import type { Metadata } from "next";
import type { ReactNode } from "react";

/** Wallet-only Portfolio routes are not in the sitemap and should not be indexed. */
export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

export default function PortfolioLayout({ children }: { children: ReactNode }) {
  return children;
}
