import type { DexModule } from "../registry";
import { orcaWhirlpoolDescriptor } from "./descriptor";

/**
 * Server registration of Orca Whirlpool (E1). Read-only adapter, lazy so other routes do not
 * bundle it. No `poolSource` / `poolDailyApr` / `recordDailyTvl`: discovery stays on the existing
 * flag-gated `/api/protocol-pools` path.
 *
 * `enabled` is always false in this series: the generic `/api/dex/[dex]/[op]` route 404s for every
 * Orca op, in every deploy target, without loading the adapter. Production discovery/positions
 * flags stay off separately. This is stricter than "positions follow the preview flag", so the
 * unified positions UI cannot gain Orca rows in preview either (PM, 2026-11-12).
 */
export const orcaWhirlpoolModule: DexModule = Object.freeze({
  descriptor: orcaWhirlpoolDescriptor,
  adapter: async () => (await import("./adapter.server")).createOrcaWhirlpoolAdapter(),
  enabled: () => false,
});
