/**
 * Pure checks behind the shared DEX contract suite. Each returns a list of problems (empty = passes), so the suite
 * (`dex-contract.ts`) stays declarative and the checks themselves are unit-tested against deliberately broken input.
 */
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount,
} from "@solana/web3.js";
import { assertNoDirectFeeWalletInstructions } from "@sofinance/engine/swap/fee";
import type { UnifiedPosition } from "@/lib/unified-positions/model";
import type { DexAdapter, OpenQuote, StepResult } from "../adapter";
import { DexError } from "../errors";
import { dexDescriptorProblems } from "../registry";
import { isDexId, type DexDescriptor } from "../types";

/** Solana's packet limit for one serialized transaction. */
export const SOLANA_MAX_TX_BYTES = 1232;
/** Highest compute-unit limit a transaction may request. */
export const SOLANA_MAX_COMPUTE_UNITS = 1_400_000;

export function descriptorContractProblems(descriptor: DexDescriptor): string[] {
  const problems = dexDescriptorProblems([descriptor]);
  if (!isDexId(descriptor.id)) problems.push(`id "${descriptor.id}" is not a canonical DexId`);
  const solana = descriptor.chain === "solana";
  const { capabilities: caps, meta } = descriptor;
  if (solana !== (caps.signer === "solana-wallet")) problems.push(`signer ${caps.signer} does not match chain ${descriptor.chain}`);
  if (solana && meta.approvals !== "none") problems.push("Solana DEXes have no token approvals");
  if (!solana && meta.rent) problems.push("only Solana DEXes declare rent");
  if (!solana && meta.positionCosigner !== "none") problems.push("EVM positions have no cosigner");
  if (meta.addressCase !== (solana ? "exact" : "lowercase")) problems.push(`addressCase ${meta.addressCase} does not match chain ${descriptor.chain}`);
  const cap = meta.maxRangeUnitsPerPosition;
  if (cap !== null && !(Number.isInteger(cap) && cap > 0)) problems.push("maxRangeUnitsPerPosition must be null or a positive integer");
  if (meta.rangeUnit === "bin" && cap === null) problems.push("bin-based DEXes must declare maxRangeUnitsPerPosition");
  for (const key of ["compound", "performance", "deposit", "withdraw", "open", "claim", "exitPreview"] as const) {
    const value = caps[key];
    if (!value.supported && !value.reason.trim()) problems.push(`${key}: an unsupported capability needs a reason`);
  }
  return problems;
}

export function adapterContractProblems(descriptor: DexDescriptor, adapter: DexAdapter): string[] {
  const problems: string[] = [];
  if (adapter.descriptor !== descriptor) problems.push("adapter.descriptor must be the registered descriptor");
  if (adapter.fees.policy !== descriptor.meta.feePolicy) problems.push("adapter.fees.policy must be descriptor.meta.feePolicy");
  return problems;
}

export function positionContractProblems(descriptor: DexDescriptor, position: UnifiedPosition): string[] {
  const problems: string[] = [];
  const where = `position ${position.key}`;
  // Canonical id only: legacy aliases are accepted by normalizeDexId for old URLs / localStorage, never from an adapter.
  if (position.source !== descriptor.id) problems.push(`${where}: source ${position.source} is not ${descriptor.id}`);
  if (position.key !== `${position.source}:${position.nativeId}`) problems.push(`${where}: key must be "<source>:<nativeId>"`);
  if (position.chain !== descriptor.chain) problems.push(`${where}: chain ${position.chain} is not ${descriptor.chain}`);
  if (position.range.mode !== descriptor.capabilities.rangeDisplay) problems.push(`${where}: range mode ${position.range.mode} does not match rangeDisplay`);
  if (!/^\d+$/.test(position.liquidity)) problems.push(`${where}: liquidity must be a base-10 integer string`);
  if (!position.poolId) problems.push(`${where}: missing poolId`);
  return problems;
}

export function quoteContractProblems(descriptor: DexDescriptor, quote: OpenQuote): string[] {
  const problems: string[] = [];
  const { min, max } = descriptor.meta.openSteps;
  if (quote.steps < min || quote.steps > max) problems.push(`quote steps ${quote.steps} outside ${min}..${max}`);
  if (Boolean(quote.rent) !== Boolean(descriptor.meta.rent)) problems.push("quote rent must be present exactly when the DEX declares rent");
  const cap = descriptor.meta.maxRangeUnitsPerPosition;
  if (!quote.blockedReason && cap !== null && quote.range.units > cap) problems.push(`range of ${quote.range.units} units exceeds the ${cap} cap without a blockedReason`);
  if (quote.blockedReason !== undefined && !quote.blockedReason.trim()) problems.push("blockedReason must be plain-English text");
  if (!/^\d+$/.test(quote.platformFeeRaw)) problems.push("platformFeeRaw must be a base-10 integer string");
  return problems;
}

/** Extra facts a step check needs that only the fixtures know. */
export type StepCheckOptions = {
  expectedSteps?: { min: number; max: number };
  /** Fee wallet the DEX collects into; when set, no instruction may pay or create accounts for it directly. */
  feeWallet?: string;
  /** Lookup tables the prepared transactions reference (recorded with the fixtures). */
  addressLookupTables?: readonly AddressLookupTableAccount[];
  /** Token program owning each mint the fixtures touch: Token-2022 mints must get Token-2022 ATAs. */
  mintPrograms?: Readonly<Record<string, "spl-token" | "token-2022">>;
  /** EVM contracts a step may call (Universal Router, PositionManager, Permit2, …), any case. */
  evmAllowedTargets?: readonly string[];
  /** The only spender an EVM `approve` may name (Permit2). */
  evmApproveSpender?: string;
};

const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

/** Solana instruction-level checks: compute budget, signers, fee-wallet guard, ATA token programs. */
function solanaInstructionProblems(descriptor: DexDescriptor, tx: VersionedTransaction, owner: string, options: StepCheckOptions): string[] {
  const problems: string[] = [];
  const { message } = tx;
  const keys = message.staticAccountKeys;
  const signers = keys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58());
  const cosigners = signers.filter((signer) => signer !== owner);
  const allowedCosigners = descriptor.meta.positionCosigner === "none" ? 0 : 1;
  if (!signers.includes(owner)) problems.push("the owner must sign");
  if (cosigners.length > allowedCosigners) problems.push(`${cosigners.length} signer(s) besides the owner; ${descriptor.meta.positionCosigner} allows ${allowedCosigners}`);

  for (const ix of message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program?.equals(ComputeBudgetProgram.programId) || ix.data[0] !== 2 || ix.data.length < 5) continue;
    const units = Buffer.from(ix.data).readUInt32LE(1);
    if (units > SOLANA_MAX_COMPUTE_UNITS) problems.push(`compute unit limit ${units} > ${SOLANA_MAX_COMPUTE_UNITS}`);
  }

  let instructions;
  try {
    instructions = TransactionMessage.decompile(message, { addressLookupTableAccounts: [...(options.addressLookupTables ?? [])] }).instructions;
  } catch {
    return [...problems, "instructions could not be decoded (missing address lookup tables in the fixtures?)"];
  }
  if (options.feeWallet) {
    try {
      assertNoDirectFeeWalletInstructions(instructions, new PublicKey(options.feeWallet));
    } catch {
      problems.push("an instruction pays or creates an account for the fee wallet directly");
    }
  }
  for (const ix of instructions) {
    if (!ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) continue;
    const [, ata, wallet, mint, , tokenProgram] = ix.keys.map((meta) => meta.pubkey);
    if (!ata || !wallet || !mint || !tokenProgram) continue;
    const expectedProgram = options.mintPrograms?.[mint.toBase58()];
    if (expectedProgram && !tokenProgram.equals(expectedProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)) {
      problems.push(`ATA for ${mint.toBase58()} uses the wrong token program (mint is ${expectedProgram})`);
    }
    if (!getAssociatedTokenAddressSync(mint, wallet, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID).equals(ata)) {
      problems.push(`ATA ${ata.toBase58()} is not derived from its owner, mint and token program`);
    }
  }
  return problems;
}

function evmStepProblems(prepared: Exclude<StepResult["prepared"], { kind: "solana-tx" }>, options: StepCheckOptions): string[] {
  if (prepared.kind !== "evm-tx") return [];
  const problems: string[] = [];
  const allowed = (options.evmAllowedTargets ?? []).map((target) => target.toLowerCase());
  if (!allowed.includes(prepared.to.toLowerCase())) problems.push(`evm-tx calls ${prepared.to}, which is not an allowlisted contract`);
  if (!/^\d+$/.test(prepared.value)) problems.push("evm-tx value must be a base-10 integer string");
  if (prepared.data.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR)) {
    const spender = `0x${prepared.data.slice(10 + 24, 10 + 64)}`.toLowerCase();
    if (!options.evmApproveSpender || spender !== options.evmApproveSpender.toLowerCase()) problems.push(`approve names spender ${spender}, not Permit2`);
  }
  return problems;
}

/** A prepared step: right kind for the chain, in-range numbering, and (Solana) a decodable, sized, owner-paid tx. */
export function stepContractProblems(descriptor: DexDescriptor, result: StepResult, owner: string, expected?: { min: number; max: number } | StepCheckOptions): string[] {
  const options: StepCheckOptions = expected && "min" in expected ? { expectedSteps: expected } : expected ?? {};
  const problems: string[] = [];
  const bounds = options.expectedSteps ?? { min: 1, max: Number.MAX_SAFE_INTEGER };
  if (result.step < 1 || result.step > result.of) problems.push(`step ${result.step} of ${result.of} is out of order`);
  if (result.of < bounds.min || result.of > bounds.max) problems.push(`${result.of} steps outside ${bounds.min}..${bounds.max}`);
  if (result.done !== (result.step === result.of)) problems.push("done must be true exactly on the last step");
  if (!result.label.trim()) problems.push("each step needs a label for the wallet prompt");
  const { prepared } = result;
  if (descriptor.chain === "solana") {
    if (prepared.kind !== "solana-tx") return [...problems, `a Solana DEX prepared a ${prepared.kind} step`];
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
    } catch {
      return [...problems, "transaction is not a base64 v0 transaction"];
    }
    const size = tx.serialize().length;
    if (size > SOLANA_MAX_TX_BYTES) problems.push(`transaction is ${size} bytes (> ${SOLANA_MAX_TX_BYTES})`);
    const payer = tx.message.staticAccountKeys[0]?.toBase58();
    if (payer !== owner) problems.push("fee payer must be the owner");
    problems.push(...solanaInstructionProblems(descriptor, tx, owner, options));
  } else if (prepared.kind === "solana-tx") {
    problems.push("an EVM DEX prepared a Solana step");
  } else {
    problems.push(...evmStepProblems(prepared, options));
  }
  return problems;
}

/** Anything an adapter throws must be a DexError (mapped to user copy by the tx pipeline). */
export function thrownErrorProblems(error: unknown): string[] {
  if (error instanceof DexError) return [];
  const name = error instanceof Error ? error.name : typeof error;
  return [`threw ${name} instead of a DexError`];
}

/** Hosts the suite forbids during reads (GeckoTerminal quota is reserved for the pool scan). */
export const FORBIDDEN_READ_HOSTS: readonly RegExp[] = Object.freeze([/(^|\.)geckoterminal\.com$/i]);

export function forbiddenFetchProblems(urls: readonly string[]): string[] {
  return urls.flatMap((url) => {
    let host = "";
    try { host = new URL(url).host; } catch { return []; }
    return FORBIDDEN_READ_HOSTS.some((pattern) => pattern.test(host)) ? [`read called ${host}`] : [];
  });
}
