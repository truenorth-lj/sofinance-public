import { vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rhc-position-scan", () => ({
  scanRhcPositions: vi.fn(async () => ({ state: "scan", wallet: "0x2222222222222222222222222222222222222222", positions: [], scannedToBlock: "0", checkedAt: 0, rpcCalls: 0 })),
  RHC_SCAN_FAILED_MESSAGE: "Couldn't check this wallet's Robinhood Chain positions right now.",
  RhcScanBusyError: class extends Error {},
}));

import { describeDexContract } from "../__contract__/dex-contract";
import { uniswapV4RhcFixtures } from "./uniswap-v4-rhc.fixtures";
import { uniswapV4RhcModule } from "./module";

/**
 * Uniswap v4 (Robinhood Chain) against the shared DEX contract, offline. Generic money and
 * performance capabilities are unsupported; with no holdings the list is empty. The dedicated
 * open/exit routes are covered by existing engine and app tests, not this suite. fetch is
 * blocked by the vitest setup file.
 */
describeDexContract(uniswapV4RhcModule, uniswapV4RhcFixtures);
