/** Test helpers: a read-only fake Connection replaying the captured Orca mainnet accounts. */
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import accountsFixture from "../../../packages/engine/src/fixtures/orca-whirlpool-accounts-cbbtc-wbtc.json";

export const ORCA_POOL = "4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72";

type Raw = Record<string, { owner: string; data: string } | null>;

export function orcaAccounts(overrides: Raw = {}): Raw {
  return { ...(accountsFixture.accounts as Raw), ...overrides };
}

export function fakeOrcaConnection(accounts: Raw = orcaAccounts()) {
  const info = (key: PublicKey): AccountInfo<Buffer> | null => {
    const raw = accounts[key.toBase58()];
    return raw ? { owner: new PublicKey(raw.owner), data: Buffer.from(raw.data, "base64"), lamports: 1, executable: false, rentEpoch: 0 } : null;
  };
  const calls: string[][] = [];
  const connection = {
    getAccountInfo: async (key: PublicKey) => { calls.push([key.toBase58()]); return info(key); },
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
      calls.push(keys.map((key) => key.toBase58()));
      return { context: { slot: accountsFixture.slot }, value: keys.map(info) };
    },
  } as unknown as Connection;
  return { connection, calls };
}
