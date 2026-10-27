import { Keypair, SystemInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect, it } from "vitest";
import { createIsolatedTokenAccountInstructions } from "./isolated-account";

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey, sponsor = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
const account = { seed: "a".repeat(22), address: Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58(), mint: Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58(),
  program: TOKEN_PROGRAM_ID.toBase58(), space: 165, rentLamports: 2_039_280 };

it("defaults the rent funder to the wallet (owner mode unchanged)", () => {
  expect(createIsolatedTokenAccountInstructions(wallet, account)).toEqual(createIsolatedTokenAccountInstructions(wallet, account, wallet));
});
it("lets a sponsor fund the account while the wallet stays seed base and owner", () => {
  const [create, init] = createIsolatedTokenAccountInstructions(wallet, account, sponsor);
  const decoded = SystemInstruction.decodeCreateWithSeed(create!);
  expect(decoded.fromPubkey.equals(sponsor)).toBe(true);
  expect(decoded.basePubkey.equals(wallet)).toBe(true);
  expect(init!.keys[2]!.pubkey.equals(wallet)).toBe(true);
});
