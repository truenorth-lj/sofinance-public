/** Runtime-free DTO facade; native validation and engine flows own the field types. */
import type { ExitFlowResult, PositionLookup } from "@sofinance/engine/protocols/uniswap-v4/exit-flow";
export type { RhcOpenRequest as EvmOpenRequest, RhcExitRequest as EvmExitRequest } from "./dex/uniswap-v4-rhc/liquidity-input";
export type { OpenFlowResult as EvmOpenResult } from "@sofinance/engine/protocols/uniswap-v4/open-flow";
export type EvmExitResult = ExitFlowResult | { state: "positions"; positions: PositionLookup[] };
