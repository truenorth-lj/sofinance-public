// Shared fixtures for the money-path characterization tests (selected / open /
// compound broadcast + status). Everything here is local: real web3.js
// transactions signed by throw-away deterministic keypairs, real HMAC permits,
// and no network access. Never put a real secret or a real wallet key in here.
import {
  Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { vi, type Mock } from "vitest";

export const SIGNING_SECRET = "test-signing-secret-not-a-real-key";
export const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(7));
export const FAKE_PROGRAM = new PublicKey(new Uint8Array(32).fill(9));

/** Deterministic throw-away keypair (never funded, never a real wallet). */
export function testKeypair(seedByte: number) {
  return Keypair.fromSeed(new Uint8Array(32).fill(seedByte));
}

export type BuildTxOptions = {
  payer: Keypair;
  /** Extra required signers (they become writable signer accounts after the payer). */
  extraSigners?: Keypair[];
  blockhash?: string;
  /** Bytes of padding data appended in a dummy instruction (to exceed the 1,232-byte limit). */
  paddingBytes?: number;
  /** Which signers actually sign. Default: payer + extraSigners. Use [] for an unsigned tx. */
  signWith?: Keypair[];
};

export function buildTransaction(options: BuildTxOptions) {
  const { payer, extraSigners = [], blockhash = BLOCKHASH, paddingBytes = 0 } = options;
  const instructions: TransactionInstruction[] = [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: testKeypair(200).publicKey, lamports: 1 }),
  ];
  for (const signer of extraSigners) {
    instructions.push(new TransactionInstruction({
      programId: FAKE_PROGRAM, keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(1),
    }));
  }
  if (paddingBytes > 0) {
    instructions.push(new TransactionInstruction({ programId: FAKE_PROGRAM, keys: [], data: Buffer.alloc(paddingBytes, 1) }));
  }
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  const signWith = options.signWith ?? [payer, ...extraSigners];
  if (signWith.length) transaction.sign(signWith);
  return transaction;
}

/**
 * web3.js refuses to serialize a transaction over 1,232 bytes, so an oversized one can only exist as raw
 * bytes. Take a valid signed tx with a 1,000-byte padding instruction and rewrite that instruction's
 * data length to 1,400 (+400 bytes) without touching anything else.
 */
export function oversizedSignedBase64(payer: Keypair) {
  const bytes = Buffer.from(buildTransaction({ payer, paddingBytes: 1_000 }).serialize());
  const lengthAt = bytes.length - 1 - 1_000 - 2; // [data len shortvec][data][0x00 = no address table lookups]
  if (bytes[lengthAt] !== (1_000 & 0x7f | 0x80) || bytes[lengthAt + 1] !== 1_000 >> 7) throw new Error("fixture layout changed");
  bytes[lengthAt] = 1_400 & 0x7f | 0x80;
  bytes[lengthAt + 1] = 1_400 >> 7;
  return Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.alloc(400, 1), bytes.subarray(bytes.length - 1)]).toString("base64");
}

export const toBase64 = (transaction: VersionedTransaction) => Buffer.from(transaction.serialize()).toString("base64");
export const messageBase64 = (transaction: VersionedTransaction) => Buffer.from(transaction.message.serialize()).toString("base64");
export const signatureOf = (transaction: VersionedTransaction) => bs58.encode(transaction.signatures[0]!);

export function jsonRequest(url: string, body: unknown, init: RequestInit = {}) {
  return new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body), ...init,
  });
}

type AsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;
export type FakeConnection = {
  getBlockHeight: AsyncMock; sendRawTransaction: AsyncMock; getSignatureStatuses: AsyncMock;
  getParsedTransaction: AsyncMock; getMultipleAccountsInfo: AsyncMock;
};

/** A fake web3.js Connection exposing only the methods the send paths call. Cast to `never` where a Connection is expected. */
export function fakeConnection(overrides: Partial<Record<keyof FakeConnection, unknown>> = {}): FakeConnection {
  const mock = (impl: (...args: unknown[]) => Promise<unknown>): AsyncMock => vi.fn(impl);
  return {
    getBlockHeight: mock(async () => 100),
    sendRawTransaction: mock(async () => { throw new Error("sendRawTransaction not configured"); }),
    getSignatureStatuses: mock(async () => ({ value: [null] })),
    getParsedTransaction: mock(async () => null),
    getMultipleAccountsInfo: mock(async () => []),
    ...overrides,
  } as FakeConnection;
}

export const BEAM_RESULT = {
  beam: { signature: "beam-sig", isLanded: true }, label: "Beam landed", provider: "default",
  beamLandingUrl: "https://beam.invalid/landing/x",
};

/** Minimal open-position summary: only the fields the send path reads, cast to the full type by callers. */
export function openSummaryFixture(input: {
  wallet: string; nftMint: string; blockhash: string; expiresAt?: number; lastValidBlockHeight?: number;
}) {
  return {
    operation: "open-position" as const, simulated: true as const,
    quote: { wallet: input.wallet, requested: "2000000", liquidity: "777", expiresAt: input.expiresAt ?? Date.now() + 60_000 },
    nftMint: input.nftMint, positionAccount: testKeypair(40).publicKey.toBase58(), nftAta: testKeypair(41).publicKey.toBase58(),
    poolId: testKeypair(42).publicKey.toBase58(), wallet: input.wallet, inputMint: "So11111111111111111111111111111111111111112",
    inputKind: "native" as const, tickLower: -60, tickUpper: 60,
    startingBalances: { input: "5000000000", a: "10", b: "20" }, simulatedEndingLiquidity: "777",
    simulatedInputSpent: null, simulatedDustA: "0", simulatedDustB: "0", simulatedSolDebitLamports: "1", maxSolDebitLamports: "9000000",
    feeLamports: 5000, rentLamports: 0, sizeBytes: 500, unitsConsumed: undefined, blockhash: input.blockhash,
    lastValidBlockHeight: input.lastValidBlockHeight ?? 150, simulatedAt: Date.now(), expiresAt: input.expiresAt ?? Date.now() + 60_000,
  };
}

/** Minimal compound summary: only the fields the send/reverify path reads. */
export function compoundSummaryFixture(input: {
  wallet: string; blockhash: string; expiresAt?: number; lastValidBlockHeight?: number; operation?: string;
}) {
  const mintA = testKeypair(21).publicKey.toBase58();
  const mintB = testKeypair(22).publicKey.toBase58();
  const state = {
    wallet: input.wallet, eligible: true, positionMint: testKeypair(20).publicKey.toBase58(),
    positionAccount: testKeypair(23).publicKey.toBase58(), poolId: testKeypair(24).publicKey.toBase58(),
    tickLower: -60, tickUpper: 60, liquidity: "1000", mintA, mintB,
    programA: testKeypair(25).publicKey.toBase58(), programB: testKeypair(26).publicKey.toBase58(),
    nftAta: testKeypair(27).publicKey.toBase58(), rangeSide: "inside",
  };
  return {
    operation: input.operation ?? "compound", simulated: true, state,
    positionMint: state.positionMint, positionAccount: state.positionAccount, poolId: state.poolId,
    startingLiquidity: "1000", liquidity: "1200", compoundAccounts: [], priorSources: [],
    maxSolDebitLamports: "9000000", blockhash: input.blockhash, lastValidBlockHeight: input.lastValidBlockHeight ?? 150,
    expiresAt: input.expiresAt ?? Date.now() + 60_000, simulatedAt: Date.now(),
  };
}
