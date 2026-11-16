import type { DexId } from "./types";
import type { EvmOpenClient, EvmExitClient, EvmOpenAttemptClient, EvmOpenStepsClient,
  EvmPositionSource, EvmAllowedPool, EvmPairLabel } from "@/lib/evm-client-types";

/** Optional native EVM browser bindings, separate from metadata and server preparation. */
export type NativeEvmClientModule = {
  readonly id: DexId;
  readonly open: EvmOpenClient;
  readonly exit: EvmExitClient;
  readonly attempt: EvmOpenAttemptClient;
  readonly steps: EvmOpenStepsClient;
  readonly pools: readonly EvmAllowedPool[];
  readonly pairLabel: EvmPairLabel;
  readonly positionSource: EvmPositionSource;
};
