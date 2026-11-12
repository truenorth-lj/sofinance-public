import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { describeDexContract } from "../__contract__/dex-contract";
import { orcaWhirlpoolFixtures } from "./orca-whirlpool.fixtures";
import { orcaWhirlpoolModule } from "./module";

/**
 * Orca Whirlpool against the shared DEX contract, offline. Money and performance capabilities
 * are unsupported; `listPositions` returns no rows. fetch is blocked by the vitest setup file;
 * these fixtures answer no HTTP, so any live call fails the suite.
 */
describeDexContract(orcaWhirlpoolModule, orcaWhirlpoolFixtures);
