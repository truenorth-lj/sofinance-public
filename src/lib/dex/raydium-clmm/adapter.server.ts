import "server-only";

import type { UnifiedPosition } from "@/lib/unified-positions/model";
import type { DexAdapter } from "../adapter";
import { DexUnsupportedError } from "../errors";
import { bpsFeeStrategy } from "../fees";
import { raydiumClmmDescriptor } from "./descriptor";
import { prepareRaydiumAdd } from "./add.server";

/**
 * Raydium's add adapter reuses the complete dedicated add builder. Other generic money /
 * plan / performance methods remain unsupported.
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
    prepareAdd: prepareRaydiumAdd,
    prepareWithdraw: unsupported,
    prepareClaim: unsupported,
    prepareCompound: unsupported,
  });
}
