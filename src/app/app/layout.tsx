import type { Metadata } from "next";
import { SITE_TITLE_TEMPLATE } from "@/lib/seo";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  // A plain string here would drop the root " · SoFinance" template for every /app page below.
  title: { default: "App", template: SITE_TITLE_TEMPLATE },
  description:
    "Connect a wallet to manage Raydium CLMM positions, compound collected trading fees, and issue a wallet-bound MCP token for AI agents.",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
