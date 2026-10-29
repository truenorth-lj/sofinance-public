import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { runWithSwapFeePaidUpstream } from "./fee-waiver";
import { readSwapFeeConfig } from "./swap/fee";

const feeWallet = Keypair.generate().publicKey.toBase58();
afterEach(() => vi.unstubAllEnvs());

describe("swap fee paid upstream (two-step SOL open)", () => {
  it("hides the protocol fee only inside the waiver scope, across awaits", async () => {
    vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet);
    vi.stubEnv("SOFINANCE_FEE_BPS", "10");
    expect(readSwapFeeConfig().bps).toBe(10);
    const inside = await runWithSwapFeePaidUpstream(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return readSwapFeeConfig();
    });
    expect(inside).toEqual({ wallet: null, bps: 0 });
    expect(readSwapFeeConfig().bps).toBe(10);
    expect(readSwapFeeConfig().wallet?.toBase58()).toBe(feeWallet);
  });

  it("does not leak into concurrent work outside the scope", async () => {
    vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet);
    vi.stubEnv("SOFINANCE_FEE_BPS", "10");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waived = runWithSwapFeePaidUpstream(async () => { await gate; return readSwapFeeConfig().bps; });
    const outside = (async () => { await Promise.resolve(); return readSwapFeeConfig().bps; })();
    expect(await outside).toBe(10);
    release();
    expect(await waived).toBe(0);
  });
});
