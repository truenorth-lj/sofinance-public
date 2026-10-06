import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, type Connection, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import type { CompoundAccount } from "./compound-types";
import type { CompoundReceipt } from "./compound-attempt";
import { verifyImportedYieldLedger, type CompoundImportOptions } from "./compound-import-ledger";

const hash = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u128 = (value: Buffer, offset: number) => value.readBigUInt64LE(offset) + (value.readBigUInt64LE(offset + 8) << 64n);

/** Recover source addresses from public chain evidence, even with no browser storage. */
export async function importCompoundReceipt(transaction: ParsedTransactionWithMeta, wallet: string, signature: string, options: CompoundImportOptions = {}): Promise<CompoundReceipt> {
  const message = transaction.transaction.message;
  if (!transaction.meta || transaction.meta.err || message.accountKeys[0]?.pubkey.toBase58() !== wallet || !message.accountKeys[0]?.signer) {
    throw new Error("This transaction is not a successful compound execution from the current wallet");
  }
  const indexed = message.instructions.flatMap((instruction, index) => instruction.programId.equals(CLMM_PROGRAM_ID) && "accounts" in instruction
    ? [{ instruction: instruction as PartiallyDecodedInstruction, index }] : []);
  const protocol = indexed.map((entry) => entry.instruction);
  const harvest = protocol[0], add = protocol[protocol.length - 1];
  if (![2, 3].includes(protocol.length) || !harvest || !add || protocol.length === 3 &&
    !Buffer.from(bs58.decode(protocol[1]!.data)).subarray(0, 8).equals(hash("swap_v2"))) throw new Error("Transaction lacks atomic harvest and reinvestment evidence");
  const harvested = Buffer.from(bs58.decode(harvest.data)), added = Buffer.from(bs58.decode(add.data));
  if (harvested.length !== 40 || !harvested.subarray(0, 8).equals(hash("decrease_liquidity_v2")) ||
    u128(harvested, 8) !== 0n || harvested.readBigUInt64LE(24) !== 0n || harvested.readBigUInt64LE(32) !== 0n ||
    added.length !== 42 || !added.subarray(0, 8).equals(hash("increase_liquidity_v2")) ||
    u128(added, 8) === 0n || added[40] !== 0 || added[41] !== 0 ||
    harvest.accounts[0]?.toBase58() !== wallet || add.accounts[0]?.toBase58() !== wallet ||
    !harvest.accounts[1]?.equals(add.accounts[1]!) || !harvest.accounts[2]?.equals(add.accounts[4]!) ||
    !harvest.accounts[3]?.equals(add.accounts[2]!)) throw new Error("Transaction original NFT, position, or yield operations do not match");
  const nftIndex = message.accountKeys.findIndex((key) => key.pubkey.equals(add.accounts[1]!));
  const nft = transaction.meta.postTokenBalances?.find((balance) => balance.accountIndex === nftIndex);
  if (!nft || nft.owner !== wallet || nft.uiTokenAmount.amount !== "1") throw new Error("Unable to verify original compound NFT");
  const accounts: CompoundAccount[] = [];
  for (let index = 0; index < 2; index++) {
    const address = add.accounts[7 + index]?.toBase58(), mint = add.accounts[13 + index]?.toBase58();
    if (!address || !mint || harvest.accounts[9 + index]?.toBase58() !== address) throw new Error("Transaction did not use dedicated yield accounts");
    const creation = message.instructions.find((instruction) => {
      if (!("parsed" in instruction) || !instruction.programId.equals(SystemProgram.programId)) return false;
      return instruction.parsed.type === "createAccountWithSeed" && instruction.parsed.info?.newAccount === address;
    });
    if (!creation || !("parsed" in creation)) throw new Error("Missing yield account creation evidence");
    const info = creation.parsed.info as Record<string, unknown>;
    if (info.source !== wallet || info.base !== wallet || typeof info.seed !== "string" || !/^(?:[0-9a-f]{32}|[A-Za-z0-9_-]{22})$/.test(info.seed) ||
      typeof info.owner !== "string" || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(info.owner) ||
      !Number.isSafeInteger(info.space) || !Number.isSafeInteger(info.lamports) ||
      (info.space as number) < 165 || (info.lamports as number) <= 0 ||
      (await PublicKey.createWithSeed(new PublicKey(wallet), info.seed, new PublicKey(info.owner))).toBase58() !== address) {
      throw new Error("Yield account seed, creator, or token program mismatch");
    }
    const initialized = message.instructions.some((instruction) => "parsed" in instruction && instruction.programId.toBase58() === info.owner &&
      instruction.parsed.type === "initializeAccount3" && instruction.parsed.info?.account === address &&
      instruction.parsed.info?.mint === mint && instruction.parsed.info?.owner === wallet);
    if (!initialized) throw new Error("Yield account initialization owner mismatch");
    accounts.push({ seed: info.seed, address, mint, program: info.owner,
      space: info.space as number, rentLamports: info.lamports as number });
  }
  const receipt = { wallet, positionMint: nft.mint, sourceSignature: signature, compoundAccounts: accounts as [CompoundAccount, CompoundAccount] };
  if (options.verifyYield !== false) await verifyImportedYieldLedger(transaction, receipt, indexed, options);
  return receipt;
}

/** Bounded finalized history tracing for old yield carried into newer attempts. */
export async function importVerifiedCompoundReceipt(connection: Connection, transaction: ParsedTransactionWithMeta, wallet: string, signature: string): Promise<CompoundReceipt> {
  const cache = new Map<string, Promise<CompoundReceipt>>();
  let reads = 0;
  const verify = (current: ParsedTransactionWithMeta, currentSignature: string, depth: number): Promise<CompoundReceipt> => {
    if (depth > 3) throw new Error("Yield history exceeds three layers, cannot safely import");
    return importCompoundReceipt(current, wallet, currentSignature, { verifyPriorCredit: async (credit) => {
      const history = await connection.getSignaturesForAddress(new PublicKey(credit.address), { limit: 12 }, "finalized");
      for (const previous of history) {
        if (previous.err || previous.slot >= current.slot) continue;
        if (++reads > 24) throw new Error("Yield history verification exceeds limit");
        const prior = await connection.getParsedTransaction(previous.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
        if (!prior || prior.transaction.signatures[0] !== previous.signature || prior.slot >= current.slot) continue;
        let imported: CompoundReceipt;
        try {
          if (!cache.has(previous.signature)) cache.set(previous.signature, verify(prior, previous.signature, depth + 1));
          imported = await cache.get(previous.signature)!;
        } catch { continue; }
        const descriptor = imported.compoundAccounts.find((account) => account.address === credit.address && account.mint === credit.mint && account.program === credit.program);
        if (!descriptor || imported.positionMint !== credit.positionMint) continue;
        const protocol = prior.transaction.message.instructions.filter((instruction): instruction is PartiallyDecodedInstruction => instruction.programId.equals(CLMM_PROGRAM_ID) && "accounts" in instruction);
        if (protocol[0]?.accounts[3]?.toBase58() !== credit.poolId || protocol[0]?.accounts[2]?.toBase58() !== credit.positionAccount) continue;
        const index = prior.transaction.message.accountKeys.findIndex((key) => key.pubkey.toBase58() === credit.address);
        const balance = prior.meta?.postTokenBalances?.find((record) => record.accountIndex === index);
        if (balance && BigInt(balance.uiTokenAmount.amount) >= credit.preAmount && credit.amount <= credit.preAmount) return;
      }
      throw new Error("Unable to verify imported original yield history source");
    } });
  };
  return verify(transaction, signature, 0);
}
