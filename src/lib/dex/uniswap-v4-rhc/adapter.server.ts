import "server-only";

import { getAddress, isAddress } from "viem";
import type { ScannedPosition } from "@sofinance/engine/protocols/uniswap-v4/position-scan";
import { RHC_SCAN_FAILED_MESSAGE, RhcScanBusyError, scanRhcPositions } from "@/lib/rhc-position-scan";
import type { UnifiedPosition } from "@/lib/unified-positions/model";
import { listRhcUnifiedPositions } from "@/lib/unified-positions/sources/rhc";
import type { DexAdapter } from "../adapter";
import { DexError, DexUnsupportedError } from "../errors";
import { bpsFeeStrategy } from "../fees";
import { uniswapV4RhcDescriptor } from "./descriptor";

/**
 * Uniswap v4 (Robinhood Chain) adapter (E2-alias). The generic StepResult money methods stay
 * unsupported: the live open/close path stays on `/api/rhc-univ4-open` and `/api/rhc-univ4-exit`
 * (same engine `prepareOpen` / `finalizeOpen` / `prepareExit` as before). `listPositions` is the
 * single on-chain holdings lister (official public RPC scan, canonical `uniswap-v4-rhc:<id>` keys).
 *
 * This adapter does not sign, send, or invent a second fee/minOut path.
 */
const unsupported = () => Promise.reject(new DexUnsupportedError());

export type UniswapV4RhcAdapterDeps = {
  /** Test hook. Production uses `scanRhcPositions` (official public RPC, never paid `RHC_RPC_URL`). */
  listHoldings?: (owner: `0x${string}`) => Promise<readonly ScannedPosition[]>;
};

export function createUniswapV4RhcAdapter(deps: UniswapV4RhcAdapterDeps = {}): DexAdapter {
  const descriptor = uniswapV4RhcDescriptor;
  return Object.freeze({
    descriptor,
    fees: bpsFeeStrategy(descriptor.meta.feePolicy),
    listPositions: async (owner: string): Promise<UnifiedPosition[]> => {
      if (!isAddress(owner, { strict: false })) throw new DexError("INVALID_REQUEST", "Invalid wallet address");
      const wallet = getAddress(owner);
      try {
        const scanned = deps.listHoldings
          ? await deps.listHoldings(wallet)
          : (await scanRhcPositions(wallet)).positions;
        return listRhcUnifiedPositions({ scanned, lookups: [] });
      } catch (error) {
        if (error instanceof DexError) throw error;
        if (error instanceof RhcScanBusyError) throw new DexError("UPSTREAM", "Robinhood Chain is busy right now. Please try again in a moment.");
        throw new DexError("UPSTREAM", RHC_SCAN_FAILED_MESSAGE);
      }
    },
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
