/** Type-only facade for the existing native wallet contract; no browser/server code is imported at runtime. */
export type EvmOpenClient = typeof import("./dex/uniswap-v4-rhc/wallet/open-execute");
export type EvmExitClient = typeof import("./dex/uniswap-v4-rhc/wallet/exit-execute");
export type EvmOpenAttemptClient = typeof import("./dex/uniswap-v4-rhc/wallet/open-attempt");
export type EvmOpenStepsClient = typeof import("./dex/uniswap-v4-rhc/wallet/open-steps");
export type EvmPairLabel = typeof import("./unified-pools/rows").rhcPairLabel;
export type EvmPositionSource = typeof import("./unified-positions/sources/rhc").rhcPositionSource;
export type { Univ4AllowlistedPool as EvmAllowedPool } from "@sofinance/engine/protocols/uniswap-v4/constants";
export type { OpenFlowResult, PermitJson } from "@sofinance/engine/protocols/uniswap-v4/open-flow";
export type { ExitFlowResult, PositionLookup, RhcPositionView } from "@sofinance/engine/protocols/uniswap-v4/exit-flow";
export type { ScannedPosition } from "@sofinance/engine/protocols/uniswap-v4/position-scan";
export type { RhcPositionValueRow } from "@sofinance/engine/protocols/uniswap-v4/position-value";
export type { RhcPoolView } from "./dex/uniswap-v4-rhc/wallet/pool-view";
export type { WalletBalances } from "./dex/uniswap-v4-rhc/wallet/exit-execute";
export type { OpenStepId } from "./dex/uniswap-v4-rhc/wallet/open-steps";
export type { RhcOpenAttempt } from "./dex/uniswap-v4-rhc/wallet/open-attempt";
export type { RhcNative } from "./unified-positions/sources/rhc";
