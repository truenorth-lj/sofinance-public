/**
 * Pure checks behind the shared DEX contract suite. Each returns a list of problems (empty = passes), so the suite
 * (`dex-contract.ts`) stays declarative and the checks themselves are unit-tested against deliberately broken input.
 */
import { VersionedTransaction } from "@solana/web3.js";
import type { UnifiedPosition } from "@/lib/unified-positions/model";
import type { DexAdapter, OpenQuote, StepResult } from "../adapter";
import { dexDescriptorProblems } from "../registry";
import { isDexId, normalizeDexId, type DexDescriptor } from "../types";

/** Solana's packet limit for one serialized transaction. */
export const SOLANA_MAX_TX_BYTES = 1232;

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
  if (normalizeDexId(position.source) !== descriptor.id) problems.push(`${where}: source ${position.source} is not ${descriptor.id}`);
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

/** A prepared step: right kind for the chain, in-range numbering, and (Solana) a decodable, sized, owner-paid tx. */
export function stepContractProblems(descriptor: DexDescriptor, result: StepResult, owner: string, expectedSteps?: { min: number; max: number }): string[] {
  const problems: string[] = [];
  const bounds = expectedSteps ?? { min: 1, max: Number.MAX_SAFE_INTEGER };
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
  } else if (prepared.kind === "solana-tx") {
    problems.push("an EVM DEX prepared a Solana step");
  }
  return problems;
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
