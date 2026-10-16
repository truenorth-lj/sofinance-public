import type { Metadata } from "next";
import { DocsShell } from "@/components/docs/docs-shell";

export const metadata: Metadata = {
  title: "Docs · SoFinance",
  description:
    "User documentation for SoFinance: non-custodial Raydium CLMM yield on Solana, fees, risks, and withdrawals.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
