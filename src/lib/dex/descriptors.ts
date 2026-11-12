import { meteoraDlmmDescriptor } from "./meteora-dlmm/descriptor";
import { orcaWhirlpoolDescriptor } from "./orca-whirlpool/descriptor";
import type { DexDescriptor } from "./types";

/**
 * Client-safe list of registered DEX descriptors; must name the same DEXes as `modules.ts` (registry.test.ts checks).
 * Each DEX adds its `src/lib/dex/<id>/descriptor.ts` here.
 */
export const DEX_DESCRIPTORS: readonly DexDescriptor[] = Object.freeze([meteoraDlmmDescriptor, orcaWhirlpoolDescriptor]);
