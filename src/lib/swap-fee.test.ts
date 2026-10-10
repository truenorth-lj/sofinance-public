import { ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeSwapFee, DEFAULT_SWAP_FEE_BPS, MAX_SWAP_FEE_BPS, netSwapInput, parseSwapFeeBps, parseSwapFeeWallet,
  readSwapFeeConfig, swapFeeQuoteFields, swapFeeRecipientAta, swapFeeTransferInstructions, unfundedSwapFeeAtaRent,
} from "./swap-fee";

const wallet = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const source = Keypair.generate().publicKey;
const payer = Keypair.generate().publicKey;

describe("parseSwapFeeBps", () => {
  it("defaults to 10 and caps at 100", () => {
    expect(parseSwapFeeBps(undefined)).toBe(DEFAULT_SWAP_FEE_BPS);
    expect(parseSwapFeeBps("")).toBe(DEFAULT_SWAP_FEE_BPS);
    expect(parseSwapFeeBps("  ")).toBe(DEFAULT_SWAP_FEE_BPS);
    expect(DEFAULT_SWAP_FEE_BPS).toBe(10);
    expect(parseSwapFeeBps("0")).toBe(0);
    expect(parseSwapFeeBps("10")).toBe(10);
    expect(parseSwapFeeBps("100")).toBe(MAX_SWAP_FEE_BPS);
    expect(parseSwapFeeBps("250")).toBe(MAX_SWAP_FEE_BPS);
  });

  it("rejects non-integers and negatives", () => {
    expect(() => parseSwapFeeBps("20.5")).toThrow(/SOFINANCE_FEE_BPS/);
    expect(() => parseSwapFeeBps("-1")).toThrow(/SOFINANCE_FEE_BPS/);
    expect(() => parseSwapFeeBps("abc")).toThrow(/SOFINANCE_FEE_BPS/);
  });
});

describe("parseSwapFeeWallet", () => {
  it("treats blank as unset and rejects invalid addresses", () => {
    expect(parseSwapFeeWallet(undefined)).toBeNull();
    expect(parseSwapFeeWallet("")).toBeNull();
    expect(parseSwapFeeWallet("   ")).toBeNull();
    expect(parseSwapFeeWallet(wallet.toBase58())?.equals(wallet)).toBe(true);
    expect(() => parseSwapFeeWallet("not-a-wallet")).toThrow(/SOFINANCE_FEE_WALLET/);
  });
});

describe("readSwapFeeConfig", () => {
  const originalWallet = process.env.SOFINANCE_FEE_WALLET;
  const originalBps = process.env.SOFINANCE_FEE_BPS;
  afterEach(() => {
    if (originalWallet === undefined) delete process.env.SOFINANCE_FEE_WALLET;
    else process.env.SOFINANCE_FEE_WALLET = originalWallet;
    if (originalBps === undefined) delete process.env.SOFINANCE_FEE_BPS;
    else process.env.SOFINANCE_FEE_BPS = originalBps;
  });

  it("is exactly zero when the wallet is unset, even if bps is set", () => {
    delete process.env.SOFINANCE_FEE_WALLET;
    process.env.SOFINANCE_FEE_BPS = "50";
    expect(readSwapFeeConfig()).toEqual({ wallet: null, bps: 0 });
    process.env.SOFINANCE_FEE_WALLET = "";
    expect(readSwapFeeConfig()).toEqual({ wallet: null, bps: 0 });
  });

  it("uses default 10 bps when only the wallet is set", () => {
    process.env.SOFINANCE_FEE_WALLET = wallet.toBase58();
    delete process.env.SOFINANCE_FEE_BPS;
    const config = readSwapFeeConfig();
    expect(config.wallet?.equals(wallet)).toBe(true);
    expect(config.bps).toBe(10);
  });
});

describe("computeSwapFee / netSwapInput", () => {
  it("floors the bps share and leaves the remainder for the swap", () => {
    expect(computeSwapFee(1_000_000n, 10)).toBe(1_000n);
    expect(computeSwapFee(999n, 10)).toBe(0n);
    expect(computeSwapFee(1_000n, 10)).toBe(1n);
    expect(netSwapInput(1_000_000n, 10)).toEqual({ feeAmount: 1_000n, swapAmount: 999_000n });
    expect(netSwapInput(999n, 10)).toEqual({ feeAmount: 0n, swapAmount: 999n });
    expect(netSwapInput(10_000n, 0)).toEqual({ feeAmount: 0n, swapAmount: 10_000n });
  });

  it("never consumes a positive swap at the 100 bps cap", () => {
    expect(netSwapInput(1n, 100)).toEqual({ feeAmount: 0n, swapAmount: 1n });
    expect(netSwapInput(100n, 100)).toEqual({ feeAmount: 1n, swapAmount: 99n });
  });
});

describe("swapFeeQuoteFields", () => {
  it("reports machine-readable zeros when disabled", () => {
    expect(swapFeeQuoteFields(1_000_000n, { wallet: null, bps: 0 })).toEqual({
      feeBps: 0, feeAmount: "0", feeWallet: null,
    });
  });

  it("reports the configured recipient and floored fee", () => {
    expect(swapFeeQuoteFields(1_000_000n, { wallet, bps: 10 })).toEqual({
      feeBps: 10, feeAmount: "1000", feeWallet: wallet.toBase58(),
    });
  });

  it("keeps feeBps but reports amount 0 when the share floors to zero", () => {
    expect(swapFeeQuoteFields(999n, { wallet, bps: 10 })).toEqual({
      feeBps: 10, feeAmount: "0", feeWallet: wallet.toBase58(),
    });
  });
});

describe("swapFeeTransferInstructions", () => {
  it("transfers native SOL with no ATA", () => {
    const [ix] = swapFeeTransferInstructions({
      payer, owner: payer, recipient: wallet, amount: 1_000n, kind: "native",
    });
    expect(ix?.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix?.keys[0]?.pubkey.equals(payer)).toBe(true);
    expect(ix?.keys[1]?.pubkey.equals(wallet)).toBe(true);
    expect(ix?.data.readBigUInt64LE(4)).toBe(1_000n);
  });

  it("creates the recipient ATA idempotently and transfer-checks the token", () => {
    const ixs = swapFeeTransferInstructions({
      payer, owner: payer, recipient: wallet, amount: 2_000n,
      kind: "token", mint, source, decimals: 6, program: TOKEN_PROGRAM_ID,
    });
    const ata = getAssociatedTokenAddressSync(mint, wallet, true, TOKEN_PROGRAM_ID);
    expect(swapFeeRecipientAta(wallet, mint, TOKEN_PROGRAM_ID).equals(ata)).toBe(true);
    expect(ixs[0]?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    const expectedCreate = createAssociatedTokenAccountIdempotentInstruction(payer, ata, wallet, mint, TOKEN_PROGRAM_ID);
    const expectedTransfer = createTransferCheckedInstruction(source, mint, ata, payer, 2_000n, 6, [], TOKEN_PROGRAM_ID);
    expect(ixs[0]?.data.equals(expectedCreate.data)).toBe(true);
    expect(ixs[1]?.data.equals(expectedTransfer.data)).toBe(true);
    expect(ixs[1]?.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("uses the Token-2022 program when the mint requires it", () => {
    const ixs = swapFeeTransferInstructions({
      payer, owner: payer, recipient: wallet, amount: 5n,
      kind: "token", mint, source, decimals: 8, program: TOKEN_2022_PROGRAM_ID,
    });
    expect(ixs[1]?.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("omits native and token instructions when the fee floors to zero", () => {
    expect(swapFeeTransferInstructions({
      payer, owner: payer, recipient: wallet, amount: 0n, kind: "native",
    })).toEqual([]);
    expect(swapFeeTransferInstructions({
      payer, owner: payer, recipient: wallet, amount: 0n,
      kind: "token", mint, source, decimals: 6, program: TOKEN_PROGRAM_ID,
    })).toEqual([]);
  });
});

describe("unfundedSwapFeeAtaRent", () => {
  it("is zero when the ATA already exists and otherwise uses mint rent", async () => {
    const ata = swapFeeRecipientAta(wallet, mint, TOKEN_PROGRAM_ID);
    const existing = await unfundedSwapFeeAtaRent({
      getMultipleAccountsInfo: async () => [{ owner: TOKEN_PROGRAM_ID }, { owner: TOKEN_PROGRAM_ID }],
    } as never, wallet, mint, TOKEN_PROGRAM_ID);
    expect(existing).toBe(0n);

    const mintData = Buffer.alloc(82);
    mintData[45] = 1;
    const missing = await unfundedSwapFeeAtaRent({
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((key) => key.equals(ata) ? null : {
        owner: TOKEN_PROGRAM_ID, data: mintData,
      }),
      getMinimumBalanceForRentExemption: async () => 2_039_280,
    } as never, wallet, mint, TOKEN_PROGRAM_ID);
    expect(missing).toBe(2_039_280n);
  });
});
