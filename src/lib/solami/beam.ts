import { PublicKey, SystemProgram, type TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import { rpcProvider, type RpcProvider } from "../rpc";

/** Documented Beam floor. Live-verified 2026-10-10: GET /onchain/tip-addresses needs no auth. */
export const BEAM_MIN_TIP_LAMPORTS = 100_000;
export const BEAM_TIP_ADDRESSES_URL = "https://api.solami.dev/onchain/tip-addresses";
export const BEAM_TX_SIZE_LIMIT = 1_232;

export type BeamEnv = Record<string, string | undefined>;

export type BeamTipPlan = {
  enabled: boolean;
  included: boolean;
  tipLamports: number;
  tipAddress: string | null;
  skippedReason: "disabled" | "no-tip-address" | "oversize" | null;
};

export type BeamLanding = {
  signature: string;
  isLanded: boolean;
  region: string | null;
  tipLamports: number | null;
  tipAddress: string | null;
  landedViaJito: boolean | null;
};

export function isBeamEnabled(env: BeamEnv = process.env as BeamEnv): boolean {
  const flag = env.SOLAMI_BEAM?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  return Boolean(env.SOLAMI_API_KEY?.trim());
}

export function beamLandingUrl(signature: string): string {
  return `https://api.solami.dev/swqos/tx/${encodeURIComponent(signature)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Live shape (verified): a JSON array of base58 tip addresses. Also accept `{ addresses }`. */
export function parseTipAddresses(raw: unknown): string[] {
  const rows = Array.isArray(raw) ? raw : Array.isArray(asRecord(raw)?.addresses) ? (asRecord(raw)!.addresses as unknown[]) : [];
  const out: string[] = [];
  for (const item of rows) {
    if (typeof item !== "string") continue;
    try {
      const key = new PublicKey(item);
      out.push(key.toBase58());
    } catch {
      /* skip */
    }
  }
  return out;
}

export function parseBeamLanding(raw: unknown, fallbackSignature?: string): BeamLanding | null {
  const record = asRecord(raw);
  if (!record) return null;
  const signature = asString(record.signature) ?? fallbackSignature ?? null;
  if (!signature) return null;
  return {
    signature,
    isLanded: record.is_landed === true || record.isLanded === true,
    region: asString(record.region),
    tipLamports: asFiniteNumber(record.tip_lamports) ?? asFiniteNumber(record.tipLamports),
    tipAddress: asString(record.tip_address) ?? asString(record.tipAddress),
    landedViaJito: asBoolean(record.landed_via_jito) ?? asBoolean(record.landedViaJito),
  };
}

export function formatBeamLanding(landing: BeamLanding): string {
  const region = landing.region ?? "unknown";
  const tip = landing.tipLamports !== null ? `${landing.tipLamports} lamports` : "tip";
  return `Landed via Beam · ${region} · ${tip}`;
}

export function measureTxSize(transaction: VersionedTransaction): number | null {
  try {
    const size = transaction.serialize().length;
    return size > BEAM_TX_SIZE_LIMIT ? null : size;
  } catch {
    return null;
  }
}

export function beamTipInstruction(from: PublicKey, tip: PublicKey, lamports = BEAM_MIN_TIP_LAMPORTS): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: tip, lamports });
}

export function chooseBeamTransaction<T extends VersionedTransaction>(
  withoutTip: T,
  withTip: T | null,
): { transaction: T; included: boolean; skippedReason: BeamTipPlan["skippedReason"] } {
  if (!withTip) return { transaction: withoutTip, included: false, skippedReason: "no-tip-address" };
  if (measureTxSize(withTip) === null) {
    return { transaction: withoutTip, included: false, skippedReason: "oversize" };
  }
  return { transaction: withTip, included: true, skippedReason: null };
}

export async function fetchBeamTipAddress(
  options: { fetcher?: typeof fetch; env?: BeamEnv } = {},
): Promise<{ address: PublicKey; lamports: number } | null> {
  const env = options.env ?? (process.env as BeamEnv);
  if (!isBeamEnabled(env)) return null;
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(BEAM_TIP_ADDRESSES_URL, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return null;
    const addresses = parseTipAddresses(await response.json());
    if (!addresses.length) return null;
    const pick = addresses[Math.floor(Math.random() * addresses.length)]!;
    return { address: new PublicKey(pick), lamports: BEAM_MIN_TIP_LAMPORTS };
  } catch {
    return null;
  }
}

export async function fetchBeamLanding(
  signature: string,
  options: { fetcher?: typeof fetch } = {},
): Promise<BeamLanding | null> {
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(beamLandingUrl(signature), { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return null;
    return parseBeamLanding(await response.json(), signature);
  } catch {
    return null;
  }
}

export const BEAM_LOOKUP_ATTEMPTS = 4;
export const BEAM_LOOKUP_GAP_MS = 1_500;

export async function lookupBeamAfterSend(
  signature: string,
  options: {
    env?: BeamEnv;
    fetcher?: typeof fetch;
    provider?: RpcProvider;
    nowWait?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ beam: BeamLanding | null; label: string | null; provider: RpcProvider; beamLandingUrl: string }> {
  const env = options.env ?? (process.env as BeamEnv);
  const provider = options.provider ?? rpcProvider(env);
  const url = beamLandingUrl(signature);
  const wait = options.nowWait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (!isBeamEnabled(env)) return { beam: null, label: null, provider, beamLandingUrl: url };
  let landing: BeamLanding | null = null;
  for (let attempt = 0; attempt < BEAM_LOOKUP_ATTEMPTS; attempt += 1) {
    landing = await fetchBeamLanding(signature, { fetcher: options.fetcher });
    if (landing?.isLanded) break;
    if (attempt < BEAM_LOOKUP_ATTEMPTS - 1) await wait(BEAM_LOOKUP_GAP_MS);
  }
  return {
    beam: landing,
    label: landing?.isLanded ? formatBeamLanding(landing) : null,
    provider,
    beamLandingUrl: url,
  };
}

export function emptyBeamPlan(): BeamTipPlan {
  return { enabled: false, included: false, tipLamports: 0, tipAddress: null, skippedReason: "disabled" };
}
