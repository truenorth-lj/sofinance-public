import { pageMetadata } from "@/lib/seo";
import { APP_ROUTES } from "@/lib/public-urls";

export const metadata = pageMetadata({
  title: "Same-stock pools on Solana and Robinhood Chain",
  description:
    "Live list of same-stock liquidity pools: Raydium CLMM on Solana and Uniswap v4 on Robinhood Chain, with fee tier, TVL, 24h volume and token risk flags.",
  path: APP_ROUTES.rwaPairs,
});

export default function RwaPairsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
