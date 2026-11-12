import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { describeDexContract } from "../__contract__/dex-contract";
import { raydiumClmmFixtures } from "./raydium-clmm.fixtures";
import { raydiumClmmModule } from "./module";

/**
 * Raydium CLMM against the shared DEX contract, offline. Generic money capabilities are
 * unsupported; `listPositions` returns no rows. fetch is blocked by the vitest setup file.
 */
describeDexContract(raydiumClmmModule, raydiumClmmFixtures);
