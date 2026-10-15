import "@/lib/engine-host";
import BN from "bn.js";
import bs58 from "bs58";
import { CLMM_PROGRAM_ID, ClmmInstrument } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { type ParsedTransactionWithMeta, type TransactionInstruction, PublicKey, SystemProgram } from "@solana/web3.js";
import type { CompoundAttempt } from "@sofinance/engine/compound-attempt";
import type { CompoundAccount, CompoundPositionState, CompoundSummary } from "@sofinance/engine/compound-types";
import { BLOCKHASH, testKeypair } from "./send-fixtures";

/** Replays the observed harvest/swap/fee/add amounts with synthetic identities, without live wallet data. */
export function compoundHistoryFixture(createdAt = Date.now()) {
  const key = (id: number) => testKeypair(id).publicKey;
  const wallet = key(1), nft = key(2), nftAta = key(3), position = key(4), pool = key(5), protocol = key(6);
  const mintA = key(7), mintB = key(8), vaultA = key(9), vaultB = key(10), ticks = key(11), feeAta = key(12);
  const owner = wallet.toBase58();
  const accounts = [0, 1].map((index) => ({ seed: String(index).repeat(22), address: key(30 + index).toBase58(),
    mint: (index === 0 ? mintA : mintB).toBase58(), program: TOKEN_2022_PROGRAM_ID.toBase58(), space: 478, rentLamports: 3_078_480 })) as [CompoundAccount, CompoundAccount];
  const parsed = (type: string, info: Record<string, unknown>, programId = TOKEN_2022_PROGRAM_ID) => ({ program: "spl-token", programId, parsed: { type, info } });
  const transfer = (source: string, destination: string, amount: string, mint: PublicKey, authority = owner) =>
    parsed("transferChecked", { source, destination, authority, mint: mint.toBase58(), tokenAmount: { amount, decimals: mint.equals(mintA) ? 8 : 6 } });
  const decoded = (ix: TransactionInstruction) => ({ programId: ix.programId, accounts: ix.keys.map((k) => k.pubkey), data: bs58.encode(ix.data) });
  const harvest = ClmmInstrument.decreaseLiquidityV2Instruction(CLMM_PROGRAM_ID, wallet, nftAta, position, pool, protocol,
    ticks, ticks, new PublicKey(accounts[0]!.address), new PublicKey(accounts[1]!.address), vaultA, vaultB, mintA, mintB, [], new BN(0), new BN(0), new BN(0));
  const swap = ClmmInstrument.swapV2Instruction(CLMM_PROGRAM_ID, wallet, pool, key(13), new PublicKey(accounts[0]!.address), new PublicKey(accounts[1]!.address),
    vaultA, vaultB, mintA, mintB, [ticks], key(14), new BN(85_230), new BN(844), new BN(0), true, key(15));
  const add = ClmmInstrument.increaseLiquidityV2Instruction(CLMM_PROGRAM_ID, wallet, nftAta, position, pool, protocol,
    ticks, ticks, new PublicKey(accounts[0]!.address), new PublicKey(accounts[1]!.address), vaultA, vaultB, mintA, mintB,
    new BN(15_948_943), new BN(392_702), new BN(1015), null);
  const signature = bs58.encode(new Uint8Array(64).fill(9));
  const balance = (accountIndex: number, mint: PublicKey, amount: string, decimals: number) => ({ accountIndex, mint: mint.toBase58(), owner,
    programId: TOKEN_2022_PROGRAM_ID.toBase58(), uiTokenAmount: { amount, decimals, uiAmount: null, uiAmountString: "0" } });
  const transaction = { slot: 1, transaction: { signatures: [signature], message: {
    accountKeys: [wallet, nftAta, ...accounts.map((a) => new PublicKey(a.address)), vaultA, vaultB, feeAta]
      .map((pubkey, index) => ({ pubkey, signer: index === 0, writable: index !== 1, source: "transaction" })),
    instructions: [parsed("computeBudget", {}), ...accounts.flatMap((account) => [
      parsed("createAccountWithSeed", { source: owner, base: owner, newAccount: account.address, seed: account.seed,
        owner: account.program, space: account.space, lamports: account.rentLamports }, SystemProgram.programId),
      parsed("initializeAccount3", { account: account.address, mint: account.mint, owner }),
    ]), decoded(harvest), parsed("createIdempotent", {}), transfer(accounts[0]!.address, feeAta.toBase58(), "85", mintA), decoded(swap), decoded(add)],
  } }, meta: { err: null, fee: 5000,
    preTokenBalances: [balance(1, nft, "1", 0)],
    postTokenBalances: [balance(1, nft, "1", 0), balance(2, mintA, "13092", 8), balance(3, mintB, "34", 6)],
    innerInstructions: [
      { index: 5, instructions: [transfer(vaultA.toBase58(), accounts[0]!.address, "478017", mintA, pool.toBase58()), transfer(vaultB.toBase58(), accounts[1]!.address, "171", mintB, pool.toBase58())] },
      { index: 8, instructions: [transfer(accounts[0]!.address, vaultA.toBase58(), "85230", mintA), transfer(vaultB.toBase58(), accounts[1]!.address, "849", mintB, pool.toBase58())] },
      { index: 9, instructions: [transfer(accounts[0]!.address, vaultA.toBase58(), "379610", mintA), transfer(accounts[1]!.address, vaultB.toBase58(), "986", mintB)] },
    ],
  } } as unknown as ParsedTransactionWithMeta;
  const state = { wallet: owner, positionMint: nft.toBase58(), positionAccount: position.toBase58(), poolId: pool.toBase58(),
    programId: CLMM_PROGRAM_ID.toBase58(), nftAta: nftAta.toBase58(), mintA: mintA.toBase58(), mintB: mintB.toBase58(),
    vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(), decimalsA: 8, decimalsB: 6, fees: { a: "478017", b: "171" },
    rewards: [], eligible: true, rangeSide: "inside" } as unknown as CompoundPositionState;
  const summary: CompoundSummary = { operation: "compound", simulated: true, state, positionMint: state.positionMint, positionAccount: state.positionAccount, poolId: state.poolId,
    startingLiquidity: "0", liquidity: "15948943", amountMaxA: "392702", amountMaxB: "1015", compoundAccounts: accounts, priorSources: [],
    swaps: [{ inputMint: state.mintA, outputMint: state.mintB, inputAmount: "85230", minOutputAmount: "844", quotedOutputAmount: "849",
      inputDecimals: 8, outputDecimals: 6, poolId: state.poolId, sqrtPriceAfterX64: "1", feeAmount: "85", feeBps: 10 }],
    simulatedHarvest: state.fees, simulatedRewards: [], simulatedEndingLiquidity: "15948943", simulatedDustA: "13092", simulatedDustB: "34",
    simulatedSolDebitLamports: "0", maxSolDebitLamports: "10000000", feeLamports: 5000, rentLamports: 6_156_960, feeAmount: "85", feeBps: 10,
    feeWallet: key(16).toBase58(), sizeBytes: 1000, blockhash: BLOCKHASH, lastValidBlockHeight: 150, expiresAt: createdAt + 60_000, simulatedAt: createdAt,
  };
  const attempt: CompoundAttempt = { version: 1, wallet: owner, positionMint: nft.toBase58(), kind: "compound", signature, createdAt, summary };
  return { wallet: owner, state, attempt, transaction };
}
