import type { ZodType } from "zod";
import type { EvmOpenRequest, EvmExitRequest, EvmOpenResult, EvmExitResult } from "@/lib/evm-liquidity-types";

/** Native Permit2/calldata transport; distinct from the generic StepResult contract. */
export type NativeEvmLiquidity = {
  enabled: () => boolean;
  schemas: Readonly<{ open: ZodType<EvmOpenRequest>; exit: ZodType<EvmExitRequest> }>;
  open: (command: EvmOpenRequest) => Promise<EvmOpenResult>;
  exit: (command: EvmExitRequest) => Promise<EvmExitResult>;
};

/** Input failures keep the native HTTP 400 contract; upstream/build failures remain separate. */
export class EvmLiquidityInputError extends Error {}
