import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ state: vi.fn(), rpc: vi.fn(), leg: vi.fn(), fee: vi.fn(), padding: 0, impact: "0.01", swapStage: false, receivedA: 200n, receivedB: 300n }));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: mocks.state }));
vi.mock("@sofinance/engine/rpc", async (importOriginal) => ({ ...await importOriginal<typeof import("@sofinance/engine/rpc")>(), rpcConnection: mocks.rpc }));
vi.mock("@sofinance/engine/swap/leg", () => ({ feeSwapLeg: mocks.leg }));
vi.mock("@sofinance/engine/swap/collection", () => ({ collectSwapFee: mocks.fee, fitFeeCollections: async (_connection: unknown, _collections: unknown, instructions: unknown) => ({ instructions }) }));
vi.mock("@sofinance/engine/solami-beam", async () => ({ ...await vi.importActual("@sofinance/engine/solami-beam"), fetchBeamTipAddress: async () => null }));
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
            after.set(ata(mintA).toBase58(), token(mintA, hasSwap ? 100n : 300n));
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
it("original withdrawal collects no swap fee and returns tokens and closing rent", async () => {
    vi.stubEnv("SOFINANCE_FEE_WALLET", "invalid");
    const prepared = await buildWithdraw({ ...request, receive: "original" });
    expect(prepared.summary.stage).toBe("atomic");
    expect(prepared.summary.closesPosition).toBe(true);
    expect(prepared.summary.rentRefundLamports).toBe("6117840");
    expect(prepared.summary.outputs.map(o => o.minimum)).toEqual(["199", "298"]);
    expect(prepared.summary.protocolFee.bps).toBe(0);
    expect(mocks.leg).not.toHaveBeenCalled();
    expect(mocks.fee).not.toHaveBeenCalled();
});
it("builds isolated atomic USDC conversions and charges only swapped legs", async () => {
    vi.stubEnv("SOFINANCE_FEE_WALLET", key(9).toBase58());
    const prepared = await buildWithdraw(request);
    expect(prepared.summary.stage).toBe("atomic");
    expect(prepared.summary.isolatedSources).toHaveLength(2);
    expect(prepared.summary.outputs[0]?.minimum).toBe("900");
    expect(prepared.summary.protocolFee.legs).toEqual([{ mint: USDC_MINT, amount: "1" }, { mint: USDC_MINT, amount: "1" }]);
    expect(mocks.fee).not.toHaveBeenCalled();
});
it("falls back to withdrawal-only when isolated conversion exceeds the packet limit", async () => {
    mocks.padding = 1100;
    const prepared = await buildWithdraw(request);
    expect(prepared.summary.transactions).toBe(2);
    expect(prepared.summary.stage).toBe("withdraw");
    expect(prepared.summary.isolatedSources).toEqual([]);
    expect(Buffer.from(prepared.unsignedTransaction, "base64").length).toBeLessThanOrEqual(1232);
});
it("previews high impact but rejects prepare without explicit confirmation", async () => {
    mocks.impact = "0.06";
    expect((await buildWithdraw(request, true)).summary.requiresSecondConfirmation).toBe(true);
    await expect(buildWithdraw(request)).rejects.toThrow("Confirm");
    expect((await buildWithdraw({ ...request, confirmHighImpact: true })).summary.requiresSecondConfirmation).toBe(true);
});
it("requires the finalized first transaction before any conversion-stage prepare", async () => {
    await expect(buildWithdraw({ ...request, stage: "swap" })).rejects.toThrow("First transaction authorization");
});
it("prepares conversion only from a finalized matching receipt and actual token credits", async () => {
    mocks.padding = 1100;
    const previous = await buildWithdraw(request);
    const first = VersionedTransaction.deserialize(Buffer.from(previous.unsignedTransaction, "base64"));
    const keys = first.message.getAccountKeys();
    const receiptBalances = (post: boolean) => previous.summary.assets.map((a, i) => ({
        accountIndex: Array.from({ length: keys.length }, (_, n) => keys.get(n)?.toBase58()).indexOf(a.account),
        mint: a.mint, owner: request.wallet, uiTokenAmount: { amount: (100n + (post ? (i === 0 ? 199n : 300n) : 0n)).toString() },
    }));
    const receipt = { transaction: { message: first.message }, meta: { err: null, loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: receiptBalances(false), postTokenBalances: receiptBalances(true) } };
    const getTransaction = vi.fn(async () => receipt);
    Object.assign(mocks.rpc(), { getTransaction });
    mocks.padding = 0;
    mocks.swapStage = true;
    mocks.receivedA = 199n;
    const second = await buildWithdraw({ ...request, stage: "swap", tx1Signature: "receipt", previous });
    expect(getTransaction).toHaveBeenCalledWith("receipt", { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    expect(second.summary.stage).toBe("swap");
    expect(second.summary.assets.map(a => a.amount)).toEqual(["199", "300"]);
    expect(second.summary.assets.map(a => a.starting)).toEqual(["299", "400"]);
});
it("rejects an absent, failed, mismatched, or under-minimum first receipt", async () => {
    mocks.padding = 1100;
    const previous = await buildWithdraw(request);
    const first = VersionedTransaction.deserialize(Buffer.from(previous.unsignedTransaction, "base64"));
    const getTransaction = vi.fn();
    Object.assign(mocks.rpc(), { getTransaction });
    const next = { ...request, stage: "swap" as const, tx1Signature: "receipt", previous };
    getTransaction.mockResolvedValue(null);
    await expect(buildWithdraw(next)).rejects.toThrow("must be finalized");
    getTransaction.mockResolvedValue({ transaction: { message: first.message }, meta: { err: "failed" } });
    await expect(buildWithdraw(next)).rejects.toThrow("must be finalized");
    getTransaction.mockResolvedValue({ transaction: { message: { serialize: () => new Uint8Array([1]) } }, meta: { err: null } });
    await expect(buildWithdraw(next)).rejects.toThrow("must be finalized");
    getTransaction.mockResolvedValue({ transaction: { message: first.message }, meta: { err: null, loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: [], postTokenBalances: [] } });
    await expect(buildWithdraw(next)).rejects.toThrow("less than minimum");
});
