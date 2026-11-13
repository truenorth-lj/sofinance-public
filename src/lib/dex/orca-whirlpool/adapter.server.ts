import "server-only";

import type { UnifiedPosition } from "@/lib/unified-positions/model";
import type { DexAdapter } from "../adapter";
import { DexUnsupportedError } from "../errors";
import { bpsFeeStrategy } from "../fees";
import { orcaWhirlpoolDescriptor } from "./descriptor";

/**
 * Read-only Orca Whirlpool adapter (E1). Every money / plan / performance method is unsupported:
 * nothing is quoted, built, signed, or sent. `listPositions` returns an empty list; the generic
 * route does not serve this adapter in this series (`module.enabled` is always false).
 *
 * No Orca SDK and no new RPC vendor. The existing official API + `rpcConnection()` path stays
 * behind the production-off discovery/positions flags and is not wired through this adapter yet.
 */
const unsupported = () => Promise.reject(new DexUnsupportedError());

export function createOrcaWhirlpoolAdapter(): DexAdapter {
  const descriptor = orcaWhirlpoolDescriptor;
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
