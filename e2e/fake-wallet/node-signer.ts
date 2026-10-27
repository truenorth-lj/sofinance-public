// The signing half of the fake wallet. Runs in the Node test process: the secret key never enters the browser,
// so it can not appear in traces, screenshots, HAR files or page console output.
import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

export type WalletMode =
  | "normal"
  | "reject"            // user rejects the request
  | "mutate-message"    // wallet appends an instruction before signing (must trip the app's content guard)
  | "tweak-bytes"       // wallet changes bytes WITHOUT changing the message length (e.g. an instruction's data)
  | "no-signature"      // wallet returns the transaction without filling its signature slot (all zeros)
  | "lighthouse"        // wallet appends a Lighthouse-style guard instruction (what Phantom/Solflare do on mainnet)
  | "slow";             // delays the answer (exercises the "Waiting for wallet signature" state)

export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export type LedgerEntry = {
  kind: "signTransaction" | "signMessage";
  outcome: "signed" | "rejected" | "refused";
  chain: string | null;
  signerIndex: number | null;
  mode: WalletMode;
  programIds: string[];
  messageBytes: number;
  reason?: string;
};

export type FakeWalletOptions = {
  secretKey?: Uint8Array;        // default: a fresh random throwaway key per instance
  name?: string;
  mode?: WalletMode;
  slowMs?: number;
  /** Hard budget: refuse to sign more than this many transactions (soft spend cap for live lanes). */
  maxSignatures?: number;
};

export class FakeWallet {
  readonly name: string;
  readonly address: string;
  readonly publicKeyBytes: Uint8Array;
  mode: WalletMode;
  slowMs: number;
  readonly ledger: LedgerEntry[] = [];
  readonly #secretKey: Uint8Array;
  readonly #maxSignatures: number;

  constructor(options: FakeWalletOptions = {}) {
    const pair = options.secretKey ? nacl.sign.keyPair.fromSecretKey(options.secretKey) : nacl.sign.keyPair();
    this.#secretKey = pair.secretKey;
    this.publicKeyBytes = pair.publicKey;
    this.address = bs58.encode(pair.publicKey);
    this.name = options.name ?? "E2E Test Wallet";   // never "Phantom"/"Solflare": AppKit maps names to explorer ids
    this.mode = options.mode ?? "normal";
    this.slowMs = options.slowMs ?? 2000;
    this.#maxSignatures = options.maxSignatures ?? 3;
  }

  /** Never expose the key: keep JSON.stringify / util.inspect / console.log of the wallet free of it. */
  toJSON() { return { name: this.name, address: this.address, mode: this.mode }; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return `FakeWallet(${this.address}, ${this.mode})`; }

  get signedTransactions() { return this.ledger.filter((e) => e.kind === "signTransaction" && e.outcome === "signed"); }

  /** Detached signature of an arbitrary message (used by tests to verify what the page posted). */
  static verify(address: string, message: Uint8Array, signature: Uint8Array) {
    return nacl.sign.detached.verify(message, signature, bs58.decode(address));
  }

  async signTransactionB64(txB64: string, chain: string | null): Promise<string> {
    const tx = VersionedTransaction.deserialize(Buffer.from(txB64, "base64"));
    const base = this.#entryBase("signTransaction", chain, tx);
    if (this.mode === "reject") {
      this.ledger.push({ ...base, outcome: "rejected", reason: "user rejected" });
      throw new Error("User rejected the request.");
    }
    if (this.signedTransactions.length >= this.#maxSignatures) {
      this.ledger.push({ ...base, outcome: "refused", reason: "signature budget exhausted" });
      throw new Error("E2E wallet policy: signature budget exhausted");
    }
    if (this.mode === "slow") await new Promise((resolve) => setTimeout(resolve, this.slowMs));
    if (this.mode === "mutate-message") appendInstruction(tx, MEMO_PROGRAM, Buffer.from("e2e-mutated"));
    if (this.mode === "tweak-bytes") {
      const ix = tx.message.compiledInstructions.at(-1)!;
      const data = Uint8Array.from(ix.data);
      data[data.length - 1] = (data[data.length - 1]! + 1) & 0xff;
      ix.data = data;
    }
    if (this.mode === "lighthouse") appendInstruction(tx, LIGHTHOUSE_PROGRAM, Buffer.from([1, 0, 0, 0]));

    const me = this.address;
    const index = tx.message.staticAccountKeys.findIndex((key) => key.toBase58() === me);
    if (index < 0 || index >= tx.message.header.numRequiredSignatures) {
      this.ledger.push({ ...base, outcome: "refused", reason: "wallet is not a required signer" });
      throw new Error("E2E wallet policy: wallet is not a required signer of this transaction");
    }
    if (this.mode === "no-signature") {
      this.ledger.push({ ...base, outcome: "signed", signerIndex: index, programIds: programIdsOf(tx), messageBytes: tx.message.serialize().length });
      return Buffer.from(tx.serialize()).toString("base64");
    }
    // Fill ONLY our slot: keeps any extra signature already on the tx (MCP open-position fallback).
    tx.signatures[index] = nacl.sign.detached(tx.message.serialize(), this.#secretKey);
    this.ledger.push({ ...base, outcome: "signed", signerIndex: index, programIds: programIdsOf(tx), messageBytes: tx.message.serialize().length });
    return Buffer.from(tx.serialize()).toString("base64");
  }

  async signMessageB64(messageB64: string): Promise<string> {
    const message = Buffer.from(messageB64, "base64");
    const entry: LedgerEntry = { kind: "signMessage", outcome: "signed", chain: null, signerIndex: null, mode: this.mode,
      programIds: [], messageBytes: message.length };
    if (this.mode === "reject") {
      this.ledger.push({ ...entry, outcome: "rejected", reason: "user rejected" });
      throw new Error("User rejected the request.");
    }
    this.ledger.push(entry);
    return Buffer.from(nacl.sign.detached(message, this.#secretKey)).toString("base64");
  }

  #entryBase(kind: LedgerEntry["kind"], chain: string | null, tx: VersionedTransaction): LedgerEntry {
    return { kind, outcome: "signed", chain, signerIndex: null, mode: this.mode, programIds: programIdsOf(tx), messageBytes: tx.message.serialize().length };
  }
}

function programIdsOf(tx: VersionedTransaction): string[] {
  const keys = tx.message.staticAccountKeys;
  return [...new Set(tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]?.toBase58() ?? "?"))];
}

/** Append a program-only instruction to a v0 message that has no lookup tables (keeps every index stable). */
function appendInstruction(tx: VersionedTransaction, programId: string, data: Uint8Array) {
  const message = tx.message;
  if (!("addressTableLookups" in message) || message.addressTableLookups.length > 0) {
    throw new Error("E2E wallet: adversarial modes only support transactions without address lookup tables");
  }
  const program = new PublicKey(programId);
  let index = message.staticAccountKeys.findIndex((key) => key.equals(program));
  if (index < 0) {
    message.staticAccountKeys.push(program);
    message.header.numReadonlyUnsignedAccounts += 1;   // appended last = readonly non-signer: all other indexes unchanged
    index = message.staticAccountKeys.length - 1;
  }
  message.compiledInstructions.push({ programIdIndex: index, accountKeyIndexes: [], data });
}
