import "server-only";

import type { UnifiedPosition } from "@/lib/unified-positions/model";
import type { DexAdapter } from "../adapter";
import { DexUnsupportedError } from "../errors";
import { bpsFeeStrategy } from "../fees";
import { uniswapV4RhcDescriptor } from "./descriptor";

/**
 * Uniswap v4 (Robinhood Chain) adapter (E2-register). The generic StepResult money methods are
 * unsupported: the live open/close path stays on `/api/rhc-univ4-open` and `/api/rhc-univ4-exit`
 * (same engine `prepareOpen` / `finalizeOpen` / `prepareExit` as before). `listPositions` returns
 * an empty list; the generic route does not serve this adapter (`module.enabled` is always false).
 *
 * This adapter does not sign, send, or invent a second fee/minOut path.
 */
const unsupported = () => Promise.reject(new DexUnsupportedError());

export function createUniswapV4RhcAdapter(): DexAdapter {
  const descriptor = uniswapV4RhcDescriptor;
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
