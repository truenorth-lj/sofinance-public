import { AccountLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { afterEach, expect, it, vi } from "vitest";
import { assertPlatformFeeQuote, netSwapInput, resolveSwapFeeConfig, swapFeeTransferInstructions } from "./fee";
const wallet = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
afterEach(() => vi.unstubAllEnvs());
it.each([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID])("never waives fees for missing operator ATA with program %s and charges existing ATA", async program => {
  vi.stubEnv("SOFINANCE_FEE_WALLET", wallet.toBase58());
  vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  const getAccountInfo = vi.fn(async () => null as unknown);
  const connection = { getAccountInfo } as unknown as Connection;
  const missing = await resolveSwapFeeConfig(connection, mint, program);
  expect(netSwapInput(1000000n, missing.bps)).toEqual({ feeAmount: 1000n, swapAmount: 999000n });
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint, owner: wallet, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  getAccountInfo.mockResolvedValue({ data, owner: program });
  const existing = await resolveSwapFeeConfig(connection, mint, program);
  const { feeAmount } = netSwapInput(1000000n, existing.bps);
  const instructions = swapFeeTransferInstructions({ kind: "token", payer: wallet, owner: wallet, recipient: wallet,
    amount: feeAmount, mint, program, source: Keypair.generate().publicKey, decimals: 6 });
  expect(feeAmount).toBe(1000n);
  expect(instructions).toHaveLength(1);
  expect(instructions[0]!.programId.equals(program)).toBe(true);
});
it("native collection needs no fee ATA", async () => {
  vi.stubEnv("SOFINANCE_FEE_WALLET", wallet.toBase58());
  vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  const getAccountInfo = vi.fn();
  expect((await resolveSwapFeeConfig({ getAccountInfo } as unknown as Connection, mint, TOKEN_PROGRAM_ID, true)).bps).toBe(10);
  expect(getAccountInfo).not.toHaveBeenCalled();
});

it("rejects an upstream fee omission or rate mismatch", () => {
  expect(() => assertPlatformFeeQuote({}, 10)).toThrow("protocol fee");
  expect(() => assertPlatformFeeQuote({ platformFee: { amount: "1", feeBps: 5 } }, 10)).toThrow("protocol fee");
  expect(() => assertPlatformFeeQuote({ platformFee: { amount: "1", feeBps: 10 } }, 10)).not.toThrow();
});
