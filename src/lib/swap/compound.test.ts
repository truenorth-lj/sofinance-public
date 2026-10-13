import BN from "bn.js";
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./jupiter", () => ({ quoteRoute: vi.fn(), buildRoute: vi.fn() }));
import { buildRoute, quoteRoute } from "./jupiter";
import { buildCompoundSwapPlan } from "./compound";
const wallet = Keypair.generate().publicKey, recipient = Keypair.generate().publicKey;
const mints = [Keypair.generate().publicKey, Keypair.generate().publicKey];
const accounts = mints.map(mint => ({ address: Keypair.generate().publicKey.toBase58(), mint: mint.toBase58(), program: TOKEN_PROGRAM_ID.toBase58() }));
const q = 1n << 64n;
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each([true, false])("compound uses Jupiter with fee ATA existing=%s and isolated accounts", async existing => {
  vi.stubEnv("SOFINANCE_FEE_WALLET", recipient.toBase58()); vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint: mints[1]!, owner: recipient, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  const quote = (inputMint: string, outputMint: string, amount: bigint) => ({ inputMint, outputMint, inAmount: amount.toString(),
    outAmount: amount.toString(), otherAmountThreshold: amount.toString(), priceImpactPct: "0",
    routePlan: [{ bps: 10000, percent: 100, swapInfo: { ammKey: "pool", inputMint, outputMint, inAmount: amount.toString(), outAmount: amount.toString() } }] });
  vi.mocked(quoteRoute).mockImplementation(async (input, output, amount) => quote(input, output, amount) as never);
  const sourceAta = getAssociatedTokenAddressSync(mints[1]!, wallet).toBase58();
  vi.mocked(buildRoute).mockImplementation(async (_wallet, input, output, amount) => ({ ...quote(input, output, amount),
    setupInstructions: [], otherInstructions: [], cleanupInstruction: null, addressesByLookupTableAddress: {},
    swapInstruction: { programId: Keypair.generate().publicKey.toBase58(), data: "AA==", accounts: [
      { pubkey: sourceAta, isWritable: true, isSigner: false },
      { pubkey: accounts[0]!.address, isWritable: true, isSigner: false },
    ] } }) as never);
  const input = { connection: { getMultipleAccountsInfoAndContext: vi.fn(async () => ({ value: [], context: { slot: 1 } })), getAccountInfo: vi.fn(async () => existing ? { data, owner: TOKEN_PROGRAM_ID } : null) },
    state: { wallet: wallet.toBase58(), mintA: mints[0]!.toBase58(), mintB: mints[1]!.toBase58(), poolId: "pool",
      decimalsA: 6, decimalsB: 6, lowerSqrtX64: (q/2n).toString(), upperSqrtX64: (q*2n).toString(), liquidity: "0" },
    accounts, computePoolInfo: { sqrtPriceX64: new BN((q/3n).toString()), liquidity: new BN("1000000000000000000") }, amountA: 0n, amountB: 1000000n };
  const result = await buildCompoundSwapPlan(input as never);
  expect(result.swap!.feeAmount).toBe(existing ? "1000" : "0");
  expect(result.swap!.inputAmount).toBe(existing ? "999000" : "1000000");
  expect(result.instructions[0]!.keys[0]!.pubkey.toBase58()).toBe(accounts[1]!.address);
  expect(result.instructions[0]!.keys[1]!.pubkey.toBase58()).toBe(accounts[0]!.address);
  expect(buildRoute).toHaveBeenCalledWith(wallet.toBase58(), accounts[1]!.mint, accounts[0]!.mint,
    existing ? 999000n : 1000000n, false, expect.objectContaining({ onlyDirectRoutes: true }), undefined, undefined, accounts[0]!.address);
  vi.mocked(quoteRoute).mockImplementation(async (input, output, amount) => ({ ...quote(input, output, amount),
    routePlan: [{ ...quote(input, output, amount).routePlan[0], swapInfo: { ...quote(input, output, amount).routePlan[0]!.swapInfo, ammKey: "unrelated" } }] }) as never);
  await expect(buildCompoundSwapPlan(input as never)).rejects.toThrow("only the original pool");
});
it("compound without a rebalance never quotes, builds or collects a fee", async () => {
  const result = await buildCompoundSwapPlan({ state: { lowerSqrtX64: (q/2n).toString(), upperSqrtX64: (q*2n).toString(), liquidity: "0" },
    computePoolInfo: { sqrtPriceX64: new BN(q.toString()) }, amountA: 100n, amountB: 100n } as never);
  expect(result.swap).toBeNull(); expect(result.instructions).toEqual([]);
  expect(quoteRoute).not.toHaveBeenCalled(); expect(buildRoute).not.toHaveBeenCalled();
});
