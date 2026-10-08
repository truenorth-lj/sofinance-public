import type { Metadata } from "next";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "App · SoFinance",
  description:
    "Connect a wallet to manage Raydium CLMM positions, compound yield, and issue a wallet-bound MCP token for AI agents.",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
