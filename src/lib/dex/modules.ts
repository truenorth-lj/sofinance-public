import type { DexModule } from "./registry";

/**
 * Registered DEXes. Empty in the skeleton PR: each DEX moves in behind this contract in its own PR (Meteora DLMM
 * first), and existing flows keep their current paths until then, so this PR changes no behavior.
 * Adding a DEX = one `src/lib/dex/<id>/module.ts` plus one line here.
 */
export const DEX_MODULES: readonly DexModule[] = Object.freeze([]);
