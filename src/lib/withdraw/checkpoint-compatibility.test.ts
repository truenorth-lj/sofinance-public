// Compatibility against the real builder using the existing build.test.ts disposable RPC fixture.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ state: vi.fn(), rpc: vi.fn(), leg: vi.fn(), fee: vi.fn(), padding: 0, tokenOutput: false, impact: "0.01", swapStage: false, receivedA: 200n, receivedB: 300n }));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: mocks.state }));
vi.mock("@sofinance/engine/rpc", async (importOriginal) => ({ ...await importOriginal<typeof import("@sofinance/engine/rpc")>(), rpcConnection: mocks.rpc }));
vi.mock("@sofinance/engine/swap/leg", () => ({ feeSwapLeg: mocks.leg }));
vi.mock("@sofinance/engine/swap/collection", () => ({ collectSwapFee: mocks.fee, fitFeeCollections: async (_connection: unknown, _collections: unknown, instructions: unknown) => ({ instructions }) }));
vi.mock("@sofinance/engine/open-transaction", async () => ({ ...await vi.importActual("@sofinance/engine/open-transaction"), openLookupTableReader: () => async () => [] }));
vi.mock("@sofinance/engine/lp-exit-instructions", async () => {
    const { TransactionInstruction } = await import("@solana/web3.js");
    return { buildPositionExitInstructions: (input: {
            recipients: PublicKey[];
            positionKey: PublicKey;
        }) => [new TransactionInstruction({ programId: input.positionKey, keys: input.recipients.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })), data: Buffer.from([1]) })] };
});
import { PublicKey, SystemProgram, VersionedTransaction, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PersonalPositionLayout, PoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import { buildWithdraw } from "@sofinance/engine/withdraw/build";
import { BLOCKHASH, SIGNING_SECRET, testKeypair } from "../test-support/send-fixtures";
import { USDC_MINT } from "@sofinance/engine/ids";
const key = (n: number) => testKeypair(n).publicKey;
const wallet = key(1), mintA = key(2), mintB = key(3), positionMint = key(4), positionKey = key(5), poolKey = key(6), nft = key(7);
const ata = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, wallet);
function info(data: Buffer, owner = TOKEN_PROGRAM_ID, lamports = 2039280) { return { data, owner, lamports, executable: false, rentEpoch: 0 }; }
function token(mint: PublicKey, amount: bigint) { const data = Buffer.alloc(165); mint.toBuffer().copy(data); wallet.toBuffer().copy(data, 32); data.writeBigUInt64LE(amount, 64); data[108] = 1; return info(data); }
function mintInfo() { const data = Buffer.alloc(82); data.writeBigUInt64LE(1000000n, 36); data[44] = 6; data[45] = 1; return info(data); }
const request = { wallet: wallet.toBase58(), positionMint: positionMint.toBase58(), percent: 100 };
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
    mocks.padding = 0;
    mocks.tokenOutput = false;
    mocks.impact = "0.01";
    mocks.swapStage = false;
    mocks.receivedA = 200n;
    mocks.receivedB = 300n;
    vi.stubEnv("SOFINANCE_FEE_WALLET", "");
    const position = Buffer.alloc(PersonalPositionLayout.span);
    poolKey.toBuffer().copy(position, PersonalPositionLayout.offsetOf("poolId"));
    positionMint.toBuffer().copy(position, PersonalPositionLayout.offsetOf("nftMint"));
    position.writeBigUInt64LE(1000n, PersonalPositionLayout.offsetOf("liquidity"));
    const pool = Buffer.alloc(PoolInfoLayout.span);
    mintA.toBuffer().copy(pool, PoolInfoLayout.offsetOf("mintA"));
    mintB.toBuffer().copy(pool, PoolInfoLayout.offsetOf("mintB"));
    pool.writeUInt16LE(64, PoolInfoLayout.offsetOf("tickSpacing"));
    const owner = info(Buffer.alloc(0), SystemProgram.programId, 100000000);
    const accounts = new Map([[wallet.toBase58(), owner], [positionKey.toBase58(), info(position)], [poolKey.toBase58(), info(pool)], [mintA.toBase58(), mintInfo()], [mintB.toBase58(), mintInfo()], [positionMint.toBase58(), mintInfo()], [nft.toBase58(), token(positionMint, 1n)], [ata(mintA).toBase58(), token(mintA, 100n)], [ata(mintB).toBase58(), token(mintB, 100n)]]);
    const connection = {
        getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(k => accounts.get(k.toBase58()) ?? null)),
        getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({ context: { slot: 10 }, value: keys.map(k => mocks.swapStage && k.equals(ata(mintA)) ? token(mintA, 100n + mocks.receivedA) : mocks.swapStage && k.equals(ata(mintB)) ? token(mintB, 100n + mocks.receivedB) : accounts.get(k.toBase58()) ?? null) })),
        getAccountInfo: vi.fn(async (k: PublicKey) => accounts.get(k.toBase58()) ?? null),
        getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 150 })),
        getMinimumBalanceForRentExemption: vi.fn(async () => 2039280), getFeeForMessage: vi.fn(async () => ({ value: 5000 })),
        simulateTransaction: vi.fn(async (tx, config: {
            accounts: {
                addresses: string[];
            };
        }) => {
            const hasSwap = tx.message.compiledInstructions.some((ix: {
                data: Uint8Array;
            }) => ix.data[0] === 77);
            const after = new Map(accounts);
            after.delete(positionKey.toBase58());
            after.delete(nft.toBase58());
            after.delete(positionMint.toBase58());
            after.set(ata(mintA).toBase58(), token(mintA, hasSwap ? (mocks.tokenOutput ? 1000n : 100n) : 300n));
            after.set(ata(mintB).toBase58(), token(mintB, hasSwap ? 100n : 400n));
            after.set(ata(new PublicKey(USDC_MINT)).toBase58(), token(new PublicKey(USDC_MINT), 1000n));
            return { context: { slot: 10 }, value: { err: null, accounts: config.accounts.addresses.map(a => { const v = after.get(a); return v ? { ...v, owner: v.owner.toBase58(), data: [v.data.toString("base64"), "base64"] } : null; }) } };
        }),
    } as unknown as Connection;
    mocks.rpc.mockReturnValue(connection);
    mocks.state.mockResolvedValue({ wallet: wallet.toBase58(), positionMint: positionMint.toBase58(), positionAccount: positionKey.toBase58(), poolId: poolKey.toBase58(), mintA: mintA.toBase58(), mintB: mintB.toBase58(), nftAta: nft.toBase58(), nftProgram: TOKEN_PROGRAM_ID.toBase58(), liquidity: "1000", currentAmounts: { a: "200", b: "300" }, decimalsA: 6, decimalsB: 6, unsupportedExtensions: [], pricing: { priceUsdA: 1, priceUsdB: 1 } });
    mocks.fee.mockResolvedValue({ instructions: [], routes: [] });
    mocks.leg.mockImplementation(async (input: {
        inputMint: string;
        outputMint: string;
        spend: bigint;
        feeBps: number;
    }) => {
        const platform = input.outputMint === USDC_MINT;
        return { feeAmount: platform ? 0n : input.spend * BigInt(input.feeBps) / 10000n, minOut: 450n, route: { inputMint: input.inputMint, outputMint: input.outputMint, inAmount: input.spend.toString(), outAmount: "500", otherAmountThreshold: "450", priceImpactPct: mocks.impact, platformFee: platform ? { amount: "1", feeBps: input.feeBps } : null, routePlan: [], addressesByLookupTableAddress: {}, setupInstructions: [], otherInstructions: [], cleanupInstruction: null, swapInstruction: { programId: key(8).toBase58(), accounts: [{ pubkey: ata(new PublicKey(input.inputMint)).toBase58(), isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from([77]), Buffer.alloc(mocks.padding)]).toString("base64") } } };
    });
});

import bs58 from "bs58";
import { isWithdrawCheckpoint } from "../withdraw-checkpoint";
import type { WithdrawPrepared, WithdrawRequest } from "@sofinance/engine/withdraw/types";
afterEach(() => vi.unstubAllEnvs());
function saved(prepared: WithdrawPrepared, original: WithdrawRequest) {
 const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.unsignedTransaction, "base64"));
 transaction.sign([testKeypair(1), ...(prepared.summary.feePayer ? [testKeypair(11)] : [])]);
 return { prepared, signature: bs58.encode(transaction.signatures[0]!), request: original, confirmHighImpact: false };
}
it.each(["original", "usdc", "token", "target", "sponsored", "first"])("accepts full real-builder %s checkpoint without changing bytes", async form => {
 const original: WithdrawRequest = form === "target" ? { wallet: request.wallet, positionMint: request.positionMint, targetUSDC: 0.0005 }
  : { ...request, ...(form === "original" || form === "sponsored" ? { receive: "original" as const } : form === "token" ? { receive: "token" as const, outputMint: mintA.toBase58() } : {}) };
 if (form === "first") mocks.padding = 1100;
 if (form === "token") mocks.tokenOutput = true;
 const prepared = await buildWithdraw(original, false, form === "sponsored" ? { feePayer: key(11).toBase58() } : {});
 const value = saved(prepared, original), raw = JSON.stringify(value);
 expect(isWithdrawCheckpoint(JSON.parse(raw), request.wallet, request.positionMint)).toBe(true);
 expect(JSON.stringify(value)).toBe(raw);
 expect(prepared.unsignedTransaction.length).toBeGreaterThan(100); expect(prepared.permit).toMatch(/^[0-9a-f]{64}$/);
 if (form === "usdc") expect(prepared.summary.isolatedSources).toHaveLength(2);
 if (form === "first") expect(prepared.summary.stage).toBe("withdraw");
});
it("accepts full builder swap and root, preserving actual finalized first bytes and optional tx1Signature", async () => {
 mocks.padding = 1100;
 const previous = await buildWithdraw(request), root = saved(previous, request);
 const first = VersionedTransaction.deserialize(Buffer.from(previous.unsignedTransaction, "base64")), keys = first.message.getAccountKeys();
 const balances = (post: boolean) => previous.summary.assets.map((a, i) => ({ accountIndex: Array.from({ length: keys.length }, (_, n) => keys.get(n)?.toBase58()).indexOf(a.account), mint: a.mint, owner: request.wallet, uiTokenAmount: { amount: (100n + (post ? (i === 0 ? 199n : 300n) : 0n)).toString() } }));
 Object.assign(mocks.rpc(), { getTransaction: vi.fn(async () => ({ transaction: { message: first.message }, meta: { err: null, loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: balances(false), postTokenBalances: balances(true) } })) });
 mocks.padding = 0; mocks.swapStage = true; mocks.receivedA = 199n;
 const prepared = await buildWithdraw({ ...request, stage: "swap", tx1Signature: root.signature, previous });
 const value = { ...saved(prepared, request), root: { prepared: previous, signature: root.signature } }, raw = JSON.stringify(value);
 expect(isWithdrawCheckpoint(JSON.parse(raw), request.wallet, request.positionMint)).toBe(true);
 expect(prepared.summary.tx1Signature).toBe(root.signature); expect(value.root.prepared).toBe(previous);
});
