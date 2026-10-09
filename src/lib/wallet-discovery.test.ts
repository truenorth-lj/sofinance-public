import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, PersonalPositionLayout, PoolInfoLayout } from "@raydium-io/raydium-sdk-v2";
import { AccountType, ExtensionType, getAssociatedTokenAddressSync, getMintLen, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, type AccountInfo, type Connection, type PublicKey } from "@solana/web3.js";

vi.mock("server-only", () => ({}));
import { discoverWallet } from "./wallet-discovery";

function info(data: Buffer, owner: PublicKey): AccountInfo<Buffer> {
  return { data, owner, executable: false, lamports: 2_039_280, rentEpoch: 0 };
}

function mint(supply: bigint, decimals: number) {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(supply, 36);
  data.writeUInt8(decimals, 44);
  data.writeUInt8(1, 45);
  return data;
}

function extendedMint(supply: bigint, decimals: number, extension: ExtensionType) {
  const data = Buffer.alloc(getMintLen([extension]));
  mint(supply, decimals).copy(data);
  data.writeUInt8(AccountType.Mint, 165);
  data.writeUInt16LE(extension, 166);
  data.writeUInt16LE(data.length - 170, 168);
  return data;
}

function tokenAccount(mintKey: PublicKey, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(165);
  mintKey.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data.writeUInt8(1, 108);
  return data;
}

function position(mintKey: PublicKey, pool: PublicKey) {
  const data = Buffer.alloc(PersonalPositionLayout.span);
  createHash("sha256").update("account:PersonalPositionState").digest().copy(data, 0, 0, 8);
  mintKey.toBuffer().copy(data, PersonalPositionLayout.offsetOf("nftMint"));
  pool.toBuffer().copy(data, PersonalPositionLayout.offsetOf("poolId"));
  data.writeInt32LE(-100, PersonalPositionLayout.offsetOf("tickLower"));
  data.writeInt32LE(100, PersonalPositionLayout.offsetOf("tickUpper"));
  data.writeBigUInt64LE(10n, PersonalPositionLayout.offsetOf("liquidity"));
  return data;
}

function pool(mintA: PublicKey, mintB: PublicKey) {
  const data = Buffer.alloc(PoolInfoLayout.span);
  createHash("sha256").update("account:PoolState").digest().copy(data, 0, 0, 8);
  mintA.toBuffer().copy(data, PoolInfoLayout.offsetOf("mintA"));
  mintB.toBuffer().copy(data, PoolInfoLayout.offsetOf("mintB"));
  data.writeBigUInt64LE(1n, PoolInfoLayout.offsetOf("sqrtPriceX64") + 8);
  return data;
}

describe("discoverWallet", () => {
  it("returns an empty position list and reserves SOL without a token account", async () => {
    const wallet = Keypair.generate().publicKey;
    const connection = {
      getTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] }),
      getBalance: vi.fn().mockResolvedValue(20_000_000),
      getSlot: vi.fn().mockResolvedValue(123),
    } as unknown as Connection;
    const result = await discoverWallet(wallet.toBase58(), connection);
    expect(result.positions).toEqual([]);
    expect(result.assets).toMatchObject([{ kind: "native", balance: "10000000", eligible: true }]);
    expect(connection.getTokenAccountsByOwner).toHaveBeenCalledTimes(2);
  });

  it("finds only an owned Raydium CLMM NFT and distinguishes ATA balance from other accounts", async () => {
    const wallet = Keypair.generate().publicKey;
    const nft = Keypair.generate().publicKey;
    const secondNft = Keypair.generate().publicKey;
    const input = Keypair.generate().publicKey;
    const mintA = Keypair.generate().publicKey;
    const mintB = Keypair.generate().publicKey;
    const poolKey = Keypair.generate().publicKey;
    const positionKey = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nft).publicKey;
    const secondPositionKey = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, secondNft).publicKey;
    const ata = getAssociatedTokenAddressSync(input, wallet, false, TOKEN_PROGRAM_ID);
    const otherAccount = Keypair.generate().publicKey;
    const accounts = new Map([
      [nft.toBase58(), info(mint(1n, 0), TOKEN_2022_PROGRAM_ID)],
      [secondNft.toBase58(), info(mint(1n, 0), TOKEN_PROGRAM_ID)],
      [input.toBase58(), info(mint(1_000_000n, 6), TOKEN_PROGRAM_ID)],
      [positionKey.toBase58(), info(position(nft, poolKey), CLMM_PROGRAM_ID)],
      [secondPositionKey.toBase58(), info(position(secondNft, poolKey), CLMM_PROGRAM_ID)],
      [poolKey.toBase58(), info(pool(mintA, mintB), CLMM_PROGRAM_ID)],
    ]);
    const connection = {
      getTokenAccountsByOwner: vi.fn().mockImplementation(async (_owner: PublicKey, filter: { programId: PublicKey }) => ({
        value: filter.programId.equals(TOKEN_PROGRAM_ID)
          ? [
            { pubkey: ata, account: info(tokenAccount(input, wallet, 2_000_000n), TOKEN_PROGRAM_ID) },
            { pubkey: otherAccount, account: info(tokenAccount(input, wallet, 3_000_000n), TOKEN_PROGRAM_ID) },
            { pubkey: getAssociatedTokenAddressSync(secondNft, wallet, false, TOKEN_PROGRAM_ID),
              account: info(tokenAccount(secondNft, wallet, 1n), TOKEN_PROGRAM_ID) },
          ]
          : [{ pubkey: getAssociatedTokenAddressSync(nft, wallet, false, TOKEN_2022_PROGRAM_ID),
            account: info(tokenAccount(nft, wallet, 1n), TOKEN_2022_PROGRAM_ID) }],
      })),
      getMultipleAccountsInfo: vi.fn().mockImplementation(async (keys: PublicKey[]) =>
        keys.map((key) => accounts.get(key.toBase58()) || null)),
      getBalance: vi.fn().mockResolvedValue(30_000_000),
      getSlot: vi.fn().mockResolvedValue(456),
    } as unknown as Connection;
    const result = await discoverWallet(wallet.toBase58(), connection);
    expect(result.positions).toHaveLength(2);
    expect(result.positions).toContainEqual(expect.objectContaining({ positionMint: nft.toBase58(), poolId: poolKey.toBase58(),
      mintA: mintA.toBase58(), mintB: mintB.toBase58(), tickLower: -100, tickUpper: 100,
      rangeSide: "inside", liquidity: "10", decimalsA: expect.any(Number), decimalsB: expect.any(Number),
      feeTierBps: null }));
    expect(result.assets.find((asset) => asset.mint === input.toBase58())).toMatchObject({
      balance: "2000000", totalBalance: "5000000", eligible: true, account: ata.toBase58(),
    });
    expect(result.assets.find((asset) => asset.mint === nft.toBase58())).toMatchObject({ eligible: false });
  });

  it("fails the whole scan when RPC data is incomplete", async () => {
    const wallet = Keypair.generate().publicKey;
    const connection = {
      getTokenAccountsByOwner: vi.fn().mockRejectedValue(new Error("RPC unavailable")),
      getBalance: vi.fn().mockResolvedValue(0), getSlot: vi.fn().mockResolvedValue(1),
    } as unknown as Connection;
    await expect(discoverWallet(wallet.toBase58(), connection)).rejects.toThrow("RPC unavailable");
  });

  it("offers a ConfidentialTransferMint token's public ATA balance but keeps unsupported extensions blocked", async () => {
    const wallet = Keypair.generate().publicKey;
    const confidentialMint = Keypair.generate().publicKey;
    const nonTransferableMint = Keypair.generate().publicKey;
    const publicAta = getAssociatedTokenAddressSync(confidentialMint, wallet, false, TOKEN_2022_PROGRAM_ID);
    const blockedAta = getAssociatedTokenAddressSync(nonTransferableMint, wallet, false, TOKEN_2022_PROGRAM_ID);
    const accounts = new Map([
      [confidentialMint.toBase58(), info(extendedMint(1_000_000n, 6, ExtensionType.ConfidentialTransferMint), TOKEN_2022_PROGRAM_ID)],
      [nonTransferableMint.toBase58(), info(extendedMint(1_000_000n, 6, ExtensionType.NonTransferable), TOKEN_2022_PROGRAM_ID)],
    ]);
    const connection = {
      getTokenAccountsByOwner: vi.fn().mockImplementation(async (_owner: PublicKey, filter: { programId: PublicKey }) => ({
        value: filter.programId.equals(TOKEN_2022_PROGRAM_ID) ? [
          { pubkey: publicAta, account: info(tokenAccount(confidentialMint, wallet, 25_000n), TOKEN_2022_PROGRAM_ID) },
          { pubkey: blockedAta, account: info(tokenAccount(nonTransferableMint, wallet, 25_000n), TOKEN_2022_PROGRAM_ID) },
        ] : [],
      })),
      getMultipleAccountsInfo: vi.fn().mockImplementation(async (keys: PublicKey[]) =>
        keys.map((key) => accounts.get(key.toBase58()) || null)),
      getBalance: vi.fn().mockResolvedValue(20_000_000),
      getSlot: vi.fn().mockResolvedValue(789),
    } as unknown as Connection;
    const result = await discoverWallet(wallet.toBase58(), connection);
    expect(result.assets.find((asset) => asset.mint === confidentialMint.toBase58())).toMatchObject({
      balance: "25000", eligible: true, account: publicAta.toBase58(),
    });
    expect(result.assets.find((asset) => asset.mint === nonTransferableMint.toBase58())).toMatchObject({
      eligible: false, reason: "Unsupported Token-2022 extension: NonTransferable",
    });
  });
});
