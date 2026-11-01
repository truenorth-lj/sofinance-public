import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const sentry = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/lib/sentry/capture", () => ({ captureDexMisconfiguration: (...args: unknown[]) => { sentry.calls.push(args); } }));

import { assertFeeWalletConfigured, FEE_WALLET_MISSING_MESSAGE } from "./fee-wallet.server";

describe("assertFeeWalletConfigured", () => {
  afterEach(() => { sentry.calls.length = 0; vi.unstubAllEnvs(); });

  it("refuses a charging operation without a fee wallet in every environment, and reports it", () => {
    for (const [node, vercel] of [["test", ""], ["development", ""], ["production", ""], ["production", "preview"], ["production", "production"]] as const) {
      vi.stubEnv("NODE_ENV", node);
      vi.stubEnv("VERCEL_ENV", vercel);
      expect(() => assertFeeWalletConfigured({ dexId: "meteora-dlmm", op: "open", charges: true, feeWallet: null }))
        .toThrow(expect.objectContaining({ code: "MISCONFIGURED", message: FEE_WALLET_MISSING_MESSAGE }));
    }
    expect(sentry.calls).toHaveLength(5);
    expect(sentry.calls[0]).toEqual(["meteora-dlmm", "open", "fee_wallet_missing"]);
  });

  it("passes when nothing is charged or a fee wallet is set", () => {
    expect(() => assertFeeWalletConfigured({ dexId: "meteora-dlmm", op: "open", charges: false, feeWallet: null })).not.toThrow();
    expect(() => assertFeeWalletConfigured({ dexId: "meteora-dlmm", op: "open", charges: true, feeWallet: "wallet" })).not.toThrow();
    expect(sentry.calls).toEqual([]);
  });
});
