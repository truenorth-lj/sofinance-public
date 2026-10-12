import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, PersonalPositionLayout, PoolInfoLayout, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { ExtensionType, getAssociatedTokenAddressSync, getTypeLen, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, type AccountInfo, type Connection } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
vi.mock("./token-prices", () => ({ fetchJupiterPricesUsd: vi.fn(), fetchRaydiumPoolUsdPrices: vi.fn() }));
import { fetchJupiterPricesUsd } from "./token-prices";
import { readSelectedPositionState } from "./selected-state";
import { MIN_SOL_LAMPORTS, NATIVE_SOL_MINT } from "./ids";

const key = () => Keypair.generate().publicKey;
const wallet = key(), nft = key(), input = key(), pool = key(), mintA = key(), mintB = key(), vaultA = key(), vaultB = key();
const selection = { positionMint: nft.toBase58(), inputMint: input.toBase58(), inputKind: "token" as const };
const position = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nft).publicKey;
const accounts = new Map<string, AccountInfo<Buffer>>();
const info = (data: Buffer, owner = TOKEN_PROGRAM_ID, lamports = 2_039_280) => ({ data, owner, executable: false, lamports, rentEpoch: 0 });
function mint(decimals = 6, supply = 1000n) {
  const data = Buffer.alloc(82); data.writeBigUInt64LE(supply, 36); data[44] = decimals; data[45] = 1; return data;
}
function token(m: PublicKey, owner: PublicKey, amount: bigint, state = 1) {
  const data = Buffer.alloc(165); m.toBuffer().copy(data); owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64); data[108] = state; return data;
}
const read = vi.fn(async (keys: PublicKey[], config?: unknown) => { void config; return { context: { slot: 42 }, value: keys.map((k) => accounts.get(k.toBase58()) ?? null) }; });
const connection = { getMultipleAccountsInfoAndContext: read, getTokenAccountsByOwner: vi.fn(), getAccountInfo: vi.fn(), getBalance: vi.fn() } as unknown as Connection;
const inputAta = getAssociatedTokenAddressSync(input, wallet), nftAta = getAssociatedTokenAddressSync(nft, wallet);
beforeEach(() => {
  vi.clearAllMocks(); accounts.clear();
  accounts.set(wallet.toBase58(), info(Buffer.alloc(0), SystemProgram.programId, 100_000_000));
  for (const m of [input, mintA, mintB]) accounts.set(m.toBase58(), info(mint()));
  accounts.set(NATIVE_SOL_MINT, info(mint(9)));
  accounts.set(nft.toBase58(), info(mint(0, 1n)));
  accounts.set(nftAta.toBase58(), info(token(nft, wallet, 1n)));
  accounts.set(inputAta.toBase58(), info(token(input, wallet, 1000n)));
  const positionData = Buffer.alloc(PersonalPositionLayout.span);
  createHash("sha256").update("account:PersonalPositionState").digest().copy(positionData, 0, 0, 8);
  nft.toBuffer().copy(positionData, PersonalPositionLayout.offsetOf("nftMint"));
  pool.toBuffer().copy(positionData, PersonalPositionLayout.offsetOf("poolId"));
  positionData.writeInt32LE(-100, PersonalPositionLayout.offsetOf("tickLower"));
  positionData.writeInt32LE(100, PersonalPositionLayout.offsetOf("tickUpper"));
  positionData.writeBigUInt64LE(10n, PersonalPositionLayout.offsetOf("liquidity"));
  accounts.set(position.toBase58(), info(positionData, CLMM_PROGRAM_ID));
  const poolData = Buffer.alloc(PoolInfoLayout.span);
  createHash("sha256").update("account:PoolState").digest().copy(poolData, 0, 0, 8);
  for (const [field, value] of [["mintA", mintA], ["mintB", mintB], ["vaultA", vaultA], ["vaultB", vaultB]] as const) value.toBuffer().copy(poolData, PoolInfoLayout.offsetOf(field));
  poolData[PoolInfoLayout.offsetOf("mintDecimalsA")] = 6; poolData[PoolInfoLayout.offsetOf("mintDecimalsB")] = 6;
  poolData.writeUInt16LE(1, PoolInfoLayout.offsetOf("tickSpacing"));
  poolData.writeBigUInt64LE(10000n, PoolInfoLayout.offsetOf("liquidity"));
  TickUtil.getSqrtPriceAtTick(0).toArrayLike(Buffer, "le", 16).copy(poolData, PoolInfoLayout.offsetOf("sqrtPriceX64"));
  accounts.set(pool.toBase58(), info(poolData, CLMM_PROGRAM_ID));
  accounts.set(vaultA.toBase58(), info(token(mintA, pool, 1000000n)));
  accounts.set(vaultB.toBase58(), info(token(mintB, pool, 1000000n)));
});
const state = (allowEmpty = false) => readSelectedPositionState(wallet.toBase58(), selection, connection, allowEmpty, { displayPrices: false });
describe("direct selected position state", () => {
  it("validates only exact selected accounts using uncached context reads without discovery or pricing", async () => {
    const result = await state();
    expect(result.inputBalance).toBe("1000"); expect(result.ownsNft).toBe(true); expect(result.slot).toBe(42);
    expect(result.vaultA).toBe(vaultA.toBase58()); expect(result.tickSpacing).toBe(1);
    expect(read).toHaveBeenCalledTimes(4);
    expect(connection.getTokenAccountsByOwner).not.toHaveBeenCalled();
    expect(connection.getAccountInfo).not.toHaveBeenCalled(); expect(connection.getBalance).not.toHaveBeenCalled();
    expect(fetchJupiterPricesUsd).not.toHaveBeenCalled();
    expect(read.mock.calls[1]?.[1]).toEqual({ commitment: "confirmed", minContextSlot: 42 });
  });
  it.each(["missing", "frozen", "wrong-owner"])("rejects %s NFT ownership", async (mode) => {
    if (mode === "missing") accounts.delete(nftAta.toBase58());
    else accounts.set(nftAta.toBase58(), info(token(nft, mode === "wrong-owner" ? key() : wallet, 1n, mode === "frozen" ? 2 : 1)));
    await expect(state()).rejects.toThrow(mode === "wrong-owner" ? "owner or mint mismatch" : "does not currently hold this Raydium CLMM position NFT");
  });
  it("rejects a counterfeit position discriminator", async () => {
    accounts.get(position.toBase58())!.data.fill(0, 0, 8);
    await expect(state()).rejects.toThrow("does not currently hold");
  });
  it("rejects an input ATA belonging to someone else", async () => {
    accounts.set(inputAta.toBase58(), info(token(input, key(), 1000n)));
    await expect(state()).rejects.toThrow("owner or mint mismatch");
  });
  it("rejects a frozen input ATA", async () => {
    accounts.set(inputAta.toBase58(), info(token(input, wallet, 1000n, 2)));
    await expect(state()).rejects.toThrow("Input asset ATA is frozen");
  });
  it("preserves allowEmptyInput for fully spent compound/status reads", async () => {
    accounts.delete(inputAta.toBase58());
    await expect(state()).rejects.toThrow("selected investable asset");
    const result = await state(true); expect(result.inputBalance).toBe("0");
    expect(result.inputAccount).toBe(inputAta.toBase58());
  });
  it("reads native SOL reserve and WSOL even when WSOL is outside the pool", async () => {
    const wsol = new PublicKey(NATIVE_SOL_MINT), wsolAta = getAssociatedTokenAddressSync(wsol, wallet);
    accounts.set(wsolAta.toBase58(), info(token(wsol, wallet, 99n)));
    const result = await readSelectedPositionState(wallet.toBase58(), { ...selection, inputMint: NATIVE_SOL_MINT, inputKind: "native" }, connection, false, { displayPrices: false });
    expect(result.inputBalance).toBe(String(100_000_000 - MIN_SOL_LAMPORTS)); expect(result.wsolBalance).toBe("99");
  });
  it("rejects a native SOL selection with a different mint", async () => {
    await expect(readSelectedPositionState(wallet.toBase58(), { ...selection, inputKind: "native" }, connection)).rejects.toThrow("Native SOL mint mismatch");
  });
});


// Construct actual Token-2022 bytes, so extension decoding is exercised rather
// than substituting already-decoded flags on a mocked state.
function extendedMint(base: Buffer, type: ExtensionType, payload: Buffer) {
  const data = Buffer.alloc(170 + payload.length); base.copy(data); data[165] = 1;
  data.writeUInt16LE(type, 166); data.writeUInt16LE(payload.length, 168); payload.copy(data, 170); return data;
}
function extendedToken(base: Buffer) { const data = Buffer.alloc(166); base.copy(data); data[165] = 2; return data; }
const extensionCases = [
  { name: "paused", type: ExtensionType.PausableConfig, field: "paused", reason: "Mint is paused",
    fill: (data: Buffer) => { data[32] = 1; } },
  { name: "transfer fee", type: ExtensionType.TransferFeeConfig, field: "transferFee", reason: "Current transfer fee exists",
    fill: (data: Buffer) => { data.writeUInt16LE(1, 88); data.writeUInt16LE(1, 106); } },
  { name: "active transfer hook", type: ExtensionType.TransferHook, field: "unsupportedExtensions", reason: "Current TransferHook exists",
    fill: (data: Buffer) => { key().toBuffer().copy(data, 32); } },
  { name: "scaled multiplier", type: ExtensionType.ScaledUiAmountConfig, field: "unsupportedExtensions", reason: "ScaledUiAmount multiplier is not 1",
    fill: (data: Buffer) => { data.writeDoubleLE(2, 32); data.writeDoubleLE(2, 48); } },
];
describe("raw Token-2022 selected state", () => {
  it("derives and verifies the Token-2022 NFT ATA without wallet discovery", async () => {
    accounts.set(nft.toBase58(), info(extendedMint(mint(0, 1n), ExtensionType.MintCloseAuthority, Buffer.alloc(32)), TOKEN_2022_PROGRAM_ID));
    accounts.delete(nftAta.toBase58());
    const token2022NftAta = getAssociatedTokenAddressSync(nft, wallet, false, TOKEN_2022_PROGRAM_ID);
    accounts.set(token2022NftAta.toBase58(), info(extendedToken(token(nft, wallet, 1n)), TOKEN_2022_PROGRAM_ID));
    const result = await state();
    expect(result.ownsNft).toBe(true); expect(result.nftAta).toBe(token2022NftAta.toBase58());
    expect(result.nftProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(connection.getTokenAccountsByOwner).not.toHaveBeenCalled();
  });
  it.each(extensionCases)("surfaces $name on a pool asset for the prepare/broadcast guard", async ({ type, fill, field }) => {
    const payload = Buffer.alloc(getTypeLen(type)); fill(payload);
    accounts.set(mintA.toBase58(), info(extendedMint(mint(), type, payload), TOKEN_2022_PROGRAM_ID));
    accounts.set(vaultA.toBase58(), info(extendedToken(token(mintA, pool, 1000000n)), TOKEN_2022_PROGRAM_ID));
    const result = await state();
    if (field === "paused") expect(result.paused).toBe(true);
    else if (field === "transferFee") expect(result.transferFee).toBe(true);
    else expect(result.unsupportedExtensions.length).toBeGreaterThan(0);
  });
  it.each(extensionCases)("rejects $name on the selected input mint", async ({ type, fill, reason }) => {
    const payload = Buffer.alloc(getTypeLen(type)); fill(payload);
    accounts.set(input.toBase58(), info(extendedMint(mint(), type, payload), TOKEN_2022_PROGRAM_ID));
    const ata = getAssociatedTokenAddressSync(input, wallet, false, TOKEN_2022_PROGRAM_ID);
    accounts.set(ata.toBase58(), info(extendedToken(token(input, wallet, 1000n)), TOKEN_2022_PROGRAM_ID));
    await expect(state()).rejects.toThrow(reason);
  });
});
