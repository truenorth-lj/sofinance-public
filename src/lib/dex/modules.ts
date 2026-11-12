import { meteoraDlmmModule } from "./meteora-dlmm/module";
import { orcaWhirlpoolModule } from "./orca-whirlpool/module";
import type { DexModule } from "./registry";

/**
 * Registered DEXes. Each DEX moves in behind this contract in its own PR (Meteora DLMM first); existing flows keep
 * their current paths until then. Adding a DEX = one `src/lib/dex/<id>/module.ts` plus one line here. Orca is registered read-only and hidden (E1).
 */
export const DEX_MODULES: readonly DexModule[] = Object.freeze([meteoraDlmmModule, orcaWhirlpoolModule]);
