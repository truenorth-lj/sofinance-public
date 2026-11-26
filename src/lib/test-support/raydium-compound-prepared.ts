import "@/lib/engine-host";
import BN from "bn.js";
import { CLMM_PROGRAM_ID, ClmmInstrument } from "@raydium-io/raydium-sdk-v2";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { CompoundPrepared } from "@sofinance/engine/compound-attempt";
import { compoundHistoryFixture } from "./compound-history-fixture";
import { testKeypair } from "./send-fixtures";

/**
 * A deterministic `/api/compound-prepare` response for one Raydium position: a compute limit, then the harvest
 * (`decrease_liquidity_v2` with zero liquidity), the harvest swap and the add, with synthetic keys. The client never
 * builds or edits these bytes; tests use them to prove the wallet is handed exactly what the server prepared.
 */
export function raydiumCompoundPrepared(positionMint: string, now = Date.now()): CompoundPrepared & { sendPermit: string; landedPermit: string } {
  const fixture = compoundHistoryFixture(now);
  const key = (id: number) => testKeypair(id).publicKey;
  const wallet = key(1), nftAta = key(3), position = key(4), pool = key(5), protocol = key(6);
  const mintA = key(7), mintB = key(8), vaultA = key(9), vaultB = key(10), ticks = key(11);
  const [a, b] = fixture.attempt.summary.compoundAccounts.map((account) => new PublicKey(account.address));
  const harvest = ClmmInstrument.decreaseLiquidityV2Instruction(CLMM_PROGRAM_ID, wallet, nftAta, position, pool, protocol,
    ticks, ticks, a!, b!, vaultA, vaultB, mintA, mintB, [], new BN(0), new BN(0), new BN(0));
  const swap = ClmmInstrument.swapV2Instruction(CLMM_PROGRAM_ID, wallet, pool, key(13), a!, b!,
    vaultA, vaultB, mintA, mintB, [ticks], key(14), new BN(85_230), new BN(844), new BN(0), true, key(15));
  const add = ClmmInstrument.increaseLiquidityV2Instruction(CLMM_PROGRAM_ID, wallet, nftAta, position, pool, protocol,
    ticks, ticks, a!, b!, vaultA, vaultB, mintA, mintB, new BN(15_948_943), new BN(392_702), new BN(1015), null);
  const summary = { ...fixture.attempt.summary, positionMint, state: { ...fixture.state, positionMint }, simulatedAt: now, expiresAt: now + 60_000 };
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: summary.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), harvest, swap, add] }).compileToV0Message());
  return { summary, permit: "synthetic", unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
    sendPermit: "synthetic-send", landedPermit: "synthetic-landed" };
}
