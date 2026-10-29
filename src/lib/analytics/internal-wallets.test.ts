import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { INTERNAL_WALLETS, isInternalWallet, walletEventProperties } from "./internal-wallets";

describe("internal wallets", () => {
  it("lists five valid, unique Solana addresses matching the agreed short forms", () => {
    expect(new Set(INTERNAL_WALLETS).size).toBe(5);
    for (const wallet of INTERNAL_WALLETS) expect(new PublicKey(wallet).toBase58()).toBe(wallet);
    const short = INTERNAL_WALLETS.map((wallet) => `${wallet.slice(0, 8)}…${wallet.slice(-4)}`);
    expect(short).toEqual(["EweTgJ6v…NEjb", "3SBfuWVR…QTNv", "tRxmfW5w…rmQa", "4mLbqtJX…UUK7", "DHkoA4Nm…JGmM"]);
  });

  it("flags only listed wallets", () => {
    expect(isInternalWallet(INTERNAL_WALLETS[0]!)).toBe(true);
    expect(isInternalWallet("So11111111111111111111111111111111111111112")).toBe(false);
    expect(isInternalWallet(undefined)).toBe(false);
    expect(walletEventProperties(INTERNAL_WALLETS[1]!)).toEqual({ wallet_address: INTERNAL_WALLETS[1]!, is_internal: true });
    expect(walletEventProperties("So11111111111111111111111111111111111111112"))
      .toEqual({ wallet_address: "So11111111111111111111111111111111111111112", is_internal: false });
    expect(walletEventProperties(null)).toEqual({ is_internal: false });
  });
});
