/**
 * Synthetic, deterministic Raydium accounts for offline add replay (not a mainnet capture).
 * The pool price is below the position: USDC goes straight into token A, with no swap and no
 * swap-input fee. Real state decoding, quote math, instruction building and simulation checks run;
 * only RPC is replaced. Simulation is an account replay, not execution of the Raydium program.
 */
import { createHash } from "node:crypto";
import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress, PersonalPositionLayout, PoolInfoLayout, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, type AccountInfo, type Connection, type SimulateTransactionConfig, type VersionedTransaction } from "@solana/web3.js";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { positionKey } from "@/lib/unified-positions/model";

const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
export const OWNER = key(1).toBase58();
export const STRANGER = key(2).toBase58();
export const FEE_WALLET = key(3).toBase58();
export const POSITION_MINT = key(4).toBase58();
export const POOL = key(5).toBase58();
export const MINT_B = key(6).toBase58();
export const BLOCKHASH = key(7).toBase58();
export const ADD_RAW = "1000000";
const POSITION_ACCOUNT = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, new PublicKey(POSITION_MINT)).publicKey.toBase58();
const VAULT_A = key(8), VAULT_B = key(9);
const STARTING_LIQUIDITY = 10n;
const OWNER_LAMPORTS = 100_000_000;

const info = (data: Buffer, owner = TOKEN_PROGRAM_ID, lamports = 2_039_280): AccountInfo<Buffer> =>
  ({ data, owner, lamports, executable: false, rentEpoch: 0 });
function mint(decimals: number, supply = 1_000_000_000n) {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(supply, 36); data[44] = decimals; data[45] = 1;
  return info(data);
}
export function tokenAccount(mint: string, owner: string, amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data); new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64); data[108] = 1;
  return info(data);
}
export const ata = (mint: string, owner = OWNER) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner)).toBase58();

export function createRaydiumAddChain() {
  const accounts = new Map<string, AccountInfo<Buffer>>();
  for (const owner of [OWNER, STRANGER]) {
    accounts.set(owner, info(Buffer.alloc(0), SystemProgram.programId, OWNER_LAMPORTS));
    accounts.set(ata(USDC_MINT, owner), tokenAccount(USDC_MINT, owner, 10_000_000n));
    accounts.set(ata(MINT_B, owner), tokenAccount(MINT_B, owner, 0n));
  }
  accounts.set(USDC_MINT, mint(6)); accounts.set(MINT_B, mint(6));
  accounts.set(NATIVE_SOL_MINT, mint(9)); accounts.set(POSITION_MINT, mint(0, 1n));
  accounts.set(ata(POSITION_MINT), tokenAccount(POSITION_MINT, OWNER, 1n));
  const position = Buffer.alloc(PersonalPositionLayout.span);
  createHash("sha256").update("account:PersonalPositionState").digest().copy(position, 0, 0, 8);
  new PublicKey(POSITION_MINT).toBuffer().copy(position, PersonalPositionLayout.offsetOf("nftMint"));
  new PublicKey(POOL).toBuffer().copy(position, PersonalPositionLayout.offsetOf("poolId"));
  position.writeInt32LE(-100, PersonalPositionLayout.offsetOf("tickLower"));
  position.writeInt32LE(100, PersonalPositionLayout.offsetOf("tickUpper"));
  position.writeBigUInt64LE(STARTING_LIQUIDITY, PersonalPositionLayout.offsetOf("liquidity"));
  accounts.set(POSITION_ACCOUNT, info(position, CLMM_PROGRAM_ID));
  const pool = Buffer.alloc(PoolInfoLayout.span);
  createHash("sha256").update("account:PoolState").digest().copy(pool, 0, 0, 8);
  for (const [field, value] of [["mintA", new PublicKey(USDC_MINT)], ["mintB", new PublicKey(MINT_B)], ["vaultA", VAULT_A], ["vaultB", VAULT_B]] as const) {
    value.toBuffer().copy(pool, PoolInfoLayout.offsetOf(field));
  }
  pool[PoolInfoLayout.offsetOf("mintDecimalsA")] = 6; pool[PoolInfoLayout.offsetOf("mintDecimalsB")] = 6;
  pool.writeUInt16LE(1, PoolInfoLayout.offsetOf("tickSpacing"));
  pool.writeInt32LE(-200, PoolInfoLayout.offsetOf("tickCurrent"));
  pool.writeBigUInt64LE(1_000_000_000n, PoolInfoLayout.offsetOf("liquidity"));
  TickUtil.getSqrtPriceAtTick(-200).toArrayLike(Buffer, "le", 16).copy(pool, PoolInfoLayout.offsetOf("sqrtPriceX64"));
  accounts.set(POOL, info(pool, CLMM_PROGRAM_ID));
  accounts.set(VAULT_A.toBase58(), tokenAccount(USDC_MINT, POOL, 1_000_000_000n));
  accounts.set(VAULT_B.toBase58(), tokenAccount(MINT_B, POOL, 1_000_000_000n));
  const simulations: VersionedTransaction[] = [];
  const connection = {
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({ context: { slot: 42 }, value: keys.map(k => accounts.get(k.toBase58()) ?? null) }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(k => accounts.get(k.toBase58()) ?? null),
    getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null,
    getAddressLookupTable: async () => ({ value: null }),
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 200 }),
    getFeeForMessage: async () => ({ value: 5_000 }),
    simulateTransaction: async (transaction: VersionedTransaction, config: SimulateTransactionConfig) => {
      simulations.push(transaction);
      const instructions = TransactionMessage.decompile(transaction.message).instructions;
      const add = instructions.find(ix => ix.programId.equals(CLMM_PROGRAM_ID));
      if (!add || !add.data.subarray(0, 8).equals(createHash("sha256").update("global:increase_liquidity_v2").digest().subarray(0, 8))) {
        throw new Error("Fixture expected one Raydium increase_liquidity_v2 instruction");
      }
      const liquidity = add.data.readBigUInt64LE(8) + (add.data.readBigUInt64LE(16) << 64n);
      const after = new Map([...accounts].map(([address, account]) => [address, { ...account, data: Buffer.from(account.data) }]));
      after.get(POSITION_ACCOUNT)!.data.writeBigUInt64LE(STARTING_LIQUIDITY + liquidity, PersonalPositionLayout.offsetOf("liquidity"));
      const input = after.get(ata(USDC_MINT))!.data;
      input.writeBigUInt64LE(input.readBigUInt64LE(64) - add.data.readBigUInt64LE(24), 64);
      after.get(OWNER)!.lamports -= 5_000;
      return { context: { slot: 42 }, value: { err: null, logs: [], unitsConsumed: 100_000,
        accounts: config.accounts!.addresses.map(address => {
          const account = after.get(address);
          return account ? { ...account, owner: account.owner.toBase58(), data: [account.data.toString("base64"), "base64"] } : null;
        }),
      } };
    },
  } as unknown as Connection;
  return { connection, accounts, simulations };
}

export const raydiumClmmFixtures = {
  owner: OWNER,
  stranger: STRANGER,
  positionKey: positionKey("raydium-clmm", POSITION_MINT),
  addInput: { token: USDC_MINT, amountRaw: ADD_RAW },
  expectedPositionKeys: [] as const,
  feeWallet: FEE_WALLET,
  mintPrograms: { [USDC_MINT]: "spl-token", [MINT_B]: "spl-token" } as const,
};
