import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { rhcPairLabel } from "./pool-presentation";
import { rhcPositionSource } from "@/lib/unified-positions/sources/rhc";
import type { NativeEvmClientModule } from "../evm-client-module";
import { uniswapV4RhcDescriptor } from "./descriptor";
import * as open from "./wallet/open-execute";
import * as exit from "./wallet/exit-execute";
import * as attempt from "./wallet/open-attempt";
import * as steps from "./wallet/open-steps";

/** Existing guards, receipt/history helpers and views; registration performs no wallet or storage request. */
export const uniswapV4RhcClientModule = Object.freeze({
  id: uniswapV4RhcDescriptor.id, open, exit, attempt, steps,
  pools: UNIV4_RHC_ALLOWLISTED_POOLS, pairLabel: rhcPairLabel, positionSource: rhcPositionSource,
} satisfies NativeEvmClientModule);
