import "server-only";

import type { UnifiedPosition } from "@/lib/unified-positions/model";
import type { DexAdapter } from "../adapter";
import { DexUnsupportedError } from "../errors";
import { bpsFeeStrategy } from "../fees";
import { raydiumClmmDescriptor } from "./descriptor";

/**
 * App-registry adapter for Raydium CLMM (E3). Every generic-route money / plan / performance
 * method is unsupported: builders stay in `@sofinance/engine` and the dedicated prepare routes.
 * `listPositions` returns an empty list; the module is not served (`enabled` is always false).
 *
 * Do not route amounts through `fees.strategy`. Collection stays in `packages/engine/src/swap/fee.ts`.
 */
const unsupported = () => Promise.reject(new DexUnsupportedError());

export function createRaydiumClmmAdapter(): DexAdapter {
  const descriptor = raydiumClmmDescriptor;
  return Object.freeze({
    descriptor,
    fees: bpsFeeStrategy(descriptor.meta.feePolicy),
    listPositions: async (): Promise<UnifiedPosition[]> => [],
    readPosition: async () => null,
    performance: unsupported,
    quoteOpen: unsupported,
    previewWithdraw: unsupported,
    prepareOpen: unsupported,
    prepareAdd: unsupported,
    prepareWithdraw: unsupported,
    prepareClaim: unsupported,
    prepareCompound: unsupported,
  });
}
