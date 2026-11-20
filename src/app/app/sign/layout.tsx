import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Wallet-only signing routes: the only /app/sign/* page is /app/sign/[token].
 * This layout covers that segment so any future sibling stays noindex too.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

export default function SignLayout({ children }: { children: ReactNode }) {
  return children;
}
