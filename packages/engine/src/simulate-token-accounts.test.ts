import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { describe, expect, it } from "vitest";
import {
  assertOriginalPoolAssetsUnspent,
  decodeTokenAccount,
  simulatedInputSpend,
  simulationTokenDust,
} from "./simulate-token-accounts";

const wallet = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const otherMint = Keypair.generate().publicKey;
const ata = Keypair.generate().publicKey;

function tokenInfo(amount: bigint, owner = wallet, tokenMint = mint, program = TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(165);
  tokenMint.toBuffer().copy(data);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { data, owner: program, executable: false, lamports: 2_039_280, rentEpoch: 0 };
}

describe("decodeTokenAccount", () => {
  it("returns 0 when the account is missing", () => {
    expect(decodeTokenAccount(null, ata, TOKEN_PROGRAM_ID, wallet, mint)).toBe(0n);
  });
  it("returns the unpacked amount for a matching ATA", () => {
    expect(decodeTokenAccount(tokenInfo(42n), ata, TOKEN_PROGRAM_ID, wallet, mint)).toBe(42n);
  });
  it("rejects a program, owner, or mint mismatch", () => {
    expect(() => decodeTokenAccount(tokenInfo(1n), ata, new PublicKey(Keypair.generate().publicKey), wallet, mint))
      .toThrow("Token ATA program mismatch");
    expect(() => decodeTokenAccount(tokenInfo(1n, Keypair.generate().publicKey), ata, TOKEN_PROGRAM_ID, wallet, mint))
      .toThrow("Token ATA owner or mint mismatch");
    expect(() => decodeTokenAccount(tokenInfo(1n, wallet, otherMint), ata, TOKEN_PROGRAM_ID, wallet, mint))
      .toThrow("Token ATA owner or mint mismatch");
  });
});

describe("assertOriginalPoolAssetsUnspent", () => {
  const base = { mintA: "A", mintB: "B", afterA: 10n, afterB: 20n, amountA: 10n, amountB: 20n };
  it("allows the input-side pool token to drop and rejects a drop in the other side", () => {
    expect(() => assertOriginalPoolAssetsUnspent({ ...base, inputMint: "A", afterA: 1n })).not.toThrow();
    expect(() => assertOriginalPoolAssetsUnspent({ ...base, inputMint: "A", afterB: 19n }))
      .toThrow("Simulation used original pool asset B");
    expect(() => assertOriginalPoolAssetsUnspent({ ...base, inputMint: "C", afterA: 9n }))
      .toThrow("Simulation used original pool asset A");
  });
});

describe("simulatedInputSpend", () => {
  const pool = { mintA: "A", mintB: "B" };
  it("returns the spent amount for a direct pool-token input within the requested limit", () => {
    expect(simulatedInputSpend({
      inputBefore: 100n, inputAfter: 40n, requested: 60n, inputMint: "A", ...pool, solDebit: 0n,
    })).toBe(60n);
    expect(simulatedInputSpend({
      inputBefore: 100n, inputAfter: 50n, requested: 60n, inputMint: "A", ...pool, solDebit: 0n,
    })).toBe(50n);
  });
  it("rejects a zero, negative, or over-limit spend", () => {
    expect(() => simulatedInputSpend({
      inputBefore: 10n, inputAfter: 10n, requested: 5n, inputMint: "A", ...pool, solDebit: 0n,
    })).toThrow(/spent 0 of 5, direct=true/);
    expect(() => simulatedInputSpend({
      inputBefore: 10n, inputAfter: 2n, requested: 5n, inputMint: "A", ...pool, solDebit: 0n,
    })).toThrow(/spent 8 of 5, direct=true/);
  });
  it("allows a cross-asset input underspend only within the 10 bps slack", () => {
    expect(simulatedInputSpend({
      inputBefore: 20_000n, inputAfter: 10_010n, requested: 10_000n, inputMint: "C", ...pool, solDebit: 0n,
    })).toBe(9_990n);
    expect(() => simulatedInputSpend({
      inputBefore: 20_000n, inputAfter: 10_011n, requested: 10_000n, inputMint: "C", ...pool, solDebit: 0n,
    })).toThrow(/spent 9989 of 10000, direct=false/);
  });
  it("checks native SOL spend against solDebit when no token accounts are present", () => {
    expect(simulatedInputSpend({
      inputBefore: null, inputAfter: null, requested: 1_000n, inputMint: "So11111111111111111111111111111111111111112",
      ...pool, solDebit: 999n,
    })).toBeNull();
    expect(() => simulatedInputSpend({
      inputBefore: null, inputAfter: null, requested: 1_000n, inputMint: "So11111111111111111111111111111111111111112",
      ...pool, solDebit: 998n,
    })).toThrow("Simulated native SOL expenditure below selected input amount");
  });
});

describe("simulationTokenDust", () => {
  it("counts a direct token input as spent when computing leftover pool-token dust", () => {
    expect(simulationTokenDust({
      afterA: 5n, afterB: 8n, amountA: 10n, amountB: 8n,
      inputKind: "token", inputMint: "A", mintA: "A", mintB: "B", requested: 12n,
    })).toEqual({ dustA: "7", dustB: "0" });
    expect(simulationTokenDust({
      afterA: 5n, afterB: 8n, amountA: 10n, amountB: 8n,
      inputKind: "native", inputMint: "A", mintA: "A", mintB: "B", requested: 12n,
    })).toEqual({ dustA: "-5", dustB: "0" });
  });
});
