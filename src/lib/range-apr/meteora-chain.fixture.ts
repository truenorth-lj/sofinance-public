/** Test helpers: a read-only fake Connection replaying the captured Meteora DLMM mainnet accounts. */
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import accountsFixture from "../../../packages/engine/src/fixtures/meteora-dlmm-accounts-cbbtc-wbtc.json";

export const METEORA_POOL = "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H";

type Raw = Record<string, { owner: string; data: string } | null>;

export function meteoraAccounts(overrides: Raw = {}): Raw {
  return { ...(accountsFixture.accounts as Raw), ...overrides };
}

export function fakeMeteoraConnection(accounts: Raw = meteoraAccounts()) {
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
