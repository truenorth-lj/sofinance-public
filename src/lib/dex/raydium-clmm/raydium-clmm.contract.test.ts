import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { describeDexContract } from "../__contract__/dex-contract";
import { createRaydiumAddChain, FEE_WALLET, raydiumClmmFixtures } from "./raydium-clmm.fixtures";
import { raydiumClmmModule } from "./module";

/**
 * Real Raydium add preparation against synthetic account / simulation replays, offline.
 * The module remains disabled for HTTP requests; the contract calls the adapter directly.
 */
const current = vi.hoisted(() => ({ chain: undefined as unknown as ReturnType<typeof createRaydiumAddChain> }));
vi.mock("@sofinance/engine/rpc", async (original) => ({
  ...await original<typeof import("@sofinance/engine/rpc")>(), rpcConnection: () => current.chain.connection,
}));
describeDexContract(raydiumClmmModule, { ...raydiumClmmFixtures, setup: () => {
  current.chain = createRaydiumAddChain();
  vi.stubEnv("SOFINANCE_FEE_WALLET", FEE_WALLET); vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  return () => { vi.unstubAllEnvs(); };
} });
