import type { Metadata } from "next";
import type { ReactNode } from "react";
import { APP_ROUTES } from "@/lib/public-urls";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "AI agents (MCP)",
  description:
    "Connect a wallet to issue a wallet-bound MCP token so AI agents can list positions and pools and prepare unsigned transactions. You sign every transaction in your wallet.",
  path: APP_ROUTES.ai,
});

export default function AiLayout({ children }: { children: ReactNode }) {
  return children;
}
