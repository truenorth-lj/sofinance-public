import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { describeDexContract } from "../__contract__/dex-contract";
import { uniswapV4RhcFixtures } from "./uniswap-v4-rhc.fixtures";
import { uniswapV4RhcModule } from "./module";

/**
 * Uniswap v4 (Robinhood Chain) against the shared DEX contract, offline. Generic money and
 * performance capabilities are unsupported; `listPositions` returns no rows. The dedicated
 * open/exit routes are covered by existing engine and app tests, not this suite. fetch is
 * blocked by the vitest setup file.
 */
describeDexContract(uniswapV4RhcModule, uniswapV4RhcFixtures);
