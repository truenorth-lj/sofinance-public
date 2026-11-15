import "@/lib/engine-host";
import "server-only";

/**
 * The live Raydium add instruction. This is the protocol builder itself, not a second
 * implementation. `DexAdapter.prepareAdd` stays unsupported while `deposit` is unsupported:
 * the shared contract requires that, and `/api/dex/raydium-clmm/*` stays 404 (`enabled` is false).
 */
export { buildRaydiumIncreaseLiquidityInstruction as buildSelectedAddInstruction } from "@sofinance/engine/protocols/raydium/add-liquidity";
