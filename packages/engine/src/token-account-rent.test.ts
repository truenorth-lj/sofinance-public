import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { getAccountLenForMint, MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import capture from "./fixtures/meteora-dlmm-rwa-t22.json";
import { associatedTokenAccountRents, associatedTokenAccountSpace, maxAssociatedTokenAccountSpace } from "./token-account-rent";

/** Mainnet rate at the capture: every recorded rent-exempt minimum is (128 + size) × 5,080. */
const rentFor = (size: number) => (128 + size) * 5_080;
const info = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({ owner, data, lamports: 0, executable: false, rentEpoch: 0 });
const mints = capture.mints as Record<string, { owner: string; data: string }>;
const rwaMints = Object.keys(mints);

function splMint() {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({
    mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
  }, data);
  return info(TOKEN_PROGRAM_ID, data);
}

function connectionFor(accounts: Map<string, AccountInfo<Buffer>>) {
  const queried: number[] = [];
  return {
    queried,
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((key) => accounts.get(key.toBase58()) ?? null),
    getMinimumBalanceForRentExemption: async (size: number) => { queried.push(size); return rentFor(size); },
  };
}

describe("associated token account rent per mint (PR9.2)", () => {
  it("sizes the recorded RWA Token-2022 mints at 179 bytes, as mainnet creates them (TransferHook + Pausable + ImmutableOwner)", () => {
    expect(rwaMints.length).toBeGreaterThanOrEqual(2);
    for (const mint of rwaMints) {
      const recorded = info(new PublicKey(mints[mint]!.owner), Buffer.from(mints[mint]!.data, "base64"));
      expect(recorded.owner.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
      expect(associatedTokenAccountSpace(new PublicKey(mint), recorded, recorded.owner)).toBe(179);
      // The SDK's mapping adds ConfidentialTransferAccount, which an ATA create does not: that is why it is not used.
      expect(getAccountLenForMint(unpackMint(new PublicKey(mint), recorded, recorded.owner))).toBeGreaterThan(179);
    }
  });

  it("keeps a plain SPL token account at 165 bytes", () => {
    expect(associatedTokenAccountSpace(Keypair.generate().publicKey, splMint(), TOKEN_PROGRAM_ID)).toBe(165);
  });

  it("prices each mint from its own on-chain owner program and extensions, in input order", async () => {
    const spl = Keypair.generate().publicKey.toBase58();
    const accounts = new Map<string, AccountInfo<Buffer>>([[spl, splMint()]]);
    for (const mint of rwaMints) accounts.set(mint, info(new PublicKey(mints[mint]!.owner), Buffer.from(mints[mint]!.data, "base64")));
    const connection = connectionFor(accounts);
    const rents = await associatedTokenAccountRents(connection, [rwaMints[0]!, spl, rwaMints[1]!]);
    expect(rents).toEqual([
      { mint: rwaMints[0], space: 179, rentLamports: BigInt(rentFor(179)) },
      { mint: spl, space: 165, rentLamports: BigInt(rentFor(165)) },
      { mint: rwaMints[1], space: 179, rentLamports: BigInt(rentFor(179)) },
    ]);
    expect(rents[0]!.rentLamports).toBe(1_559_560n); // mainnet rent of a 179-byte account, 11/1
    expect(connection.queried.sort()).toEqual([165, 179]); // one rent read per distinct size
    expect(await associatedTokenAccountRents(connection, [])).toEqual([]);
  });

  it("refuses a missing mint or one not owned by a token program", async () => {
    const missing = Keypair.generate().publicKey.toBase58();
    await expect(associatedTokenAccountRents(connectionFor(new Map()), [missing])).rejects.toThrow(/not found/);
    const stray = Keypair.generate().publicKey;
    const notToken = new Map([[stray.toBase58(), info(Keypair.generate().publicKey, splMint().data)]]);
    await expect(associatedTokenAccountRents(connectionFor(notToken), [stray.toBase58()])).rejects.toThrow(/not a token program/);
  });

  it("bounds an unknown mint's account by every required Token-2022 account extension", () => {
    expect(maxAssociatedTokenAccountSpace()).toBeGreaterThanOrEqual(179);
  });
});
