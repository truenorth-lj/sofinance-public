import { meteoraDlmmModule } from "./meteora-dlmm/module";
import { orcaWhirlpoolModule } from "./orca-whirlpool/module";
import { uniswapV4RhcModule } from "./uniswap-v4-rhc/module";
import type { DexModule } from "./registry";

/**
 * Registered DEXes. Each DEX moves in behind this contract in its own PR (Meteora DLMM first); existing flows keep
 * their current paths until then. Adding a DEX = one `src/lib/dex/<id>/module.ts` plus one line here. Orca is registered read-only and hidden (E1). Uniswap v4 on Robinhood Chain is registered (E2-register) with generic route ops disabled; dedicated open/exit routes stay the only write path.
 */
export const DEX_MODULES: readonly DexModule[] = Object.freeze([meteoraDlmmModule, orcaWhirlpoolModule, uniswapV4RhcModule]);
