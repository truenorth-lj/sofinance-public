import { notFound, redirect } from "next/navigation";
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { RHC_DEEP_LINK } from "@/lib/unified-pools/deep-link";

/**
 * Robinhood Chain now lives in the `/app` pool list (LJ 2026-10-30). `/app/rhc` keeps working as a deep link: it
 * redirects to `/app?openPool=<SPCX/SPCXon pool id>`, which opens that pool's MetaMask flow. `RHC_UNIV4_TRADING_ENABLED`
 * off → 404, as before. `src/proxy.ts` sends the real 307; this page is the fallback.
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default function RhcPage() {
  if (!isRhcUniv4TradingEnabled()) notFound();
  redirect(RHC_DEEP_LINK);
}
