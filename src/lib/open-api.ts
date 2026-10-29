import "@/lib/engine-host";
import "server-only";

import { PublicKey } from "@solana/web3.js";
import { parseAddToleranceBps, parseResaleFloorBps } from "@sofinance/engine/amount";
import { parseWallet } from "@sofinance/engine/api-input";
import { parseClientNftMint } from "@sofinance/engine/open-atomic";
import { DEFAULT_OPEN_RANGE_PRESET, type OpenRangeInput, type OpenRangePreset } from "@sofinance/engine/open-range";
import type { OpenPositionSelection } from "@sofinance/engine/open-state";
import { assertSolInputAllowed } from "./sol-input-policy";
import { parseOpenDiag } from "@sofinance/engine/diag";

const PRESETS = new Set<OpenRangePreset>(["micro", "tight", "standard", "wide", "custom"]);

export function parseOpenRange(fields: Record<string, unknown>): OpenRangeInput {
  const preset = (typeof fields.rangePreset === "string" ? fields.rangePreset : DEFAULT_OPEN_RANGE_PRESET) as OpenRangePreset;
  if (!PRESETS.has(preset)) throw new Error("Range preset must be micro, tight, standard, wide, or custom");
  if (preset === "custom") {
    if (typeof fields.minPrice !== "string" || typeof fields.maxPrice !== "string") {
      throw new Error("Custom range requires minPrice and maxPrice (B per 1 A)");
    }
    return { preset: "custom", minPrice: fields.minPrice, maxPrice: fields.maxPrice };
  }
  return { preset };
}

function parseOpenFields(fields: Record<string, unknown>) {
  const wallet = parseWallet(fields.wallet);
  if (typeof fields.poolId !== "string" || typeof fields.inputMint !== "string") {
    throw new Error("Invalid pool or input mint");
  }
  let poolId: string;
  let inputMint: string;
  try {
    poolId = new PublicKey(fields.poolId).toBase58();
    inputMint = new PublicKey(fields.inputMint).toBase58();
  } catch {
    throw new Error("Invalid pool or input mint");
  }
  if (fields.inputKind !== "native" && fields.inputKind !== "token") throw new Error("Invalid input asset type");
  if (typeof fields.amount !== "string" || fields.amount.length > 40) throw new Error("Invalid input amount");
  const selection: OpenPositionSelection = { poolId, inputMint, inputKind: fields.inputKind };
  assertSolInputAllowed(selection);
  return {
    wallet, selection, amount: fields.amount, range: parseOpenRange(fields),
    floorBps: parseResaleFloorBps(fields.resaleFloorBps ?? fields.floorBps),
    toleranceBps: parseAddToleranceBps(fields.slippageToleranceBps ?? fields.toleranceBps),
    // DIAG ONLY: ignored when VERCEL_ENV === "production".
    diag: parseOpenDiag(fields.diag, process.env.VERCEL_ENV),
  };
}

async function readOpenBody(request: Request) {
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid open-position input");
  return body as Record<string, unknown>;
}

export async function parseOpenQuoteRequest(request: Request) {
  return parseOpenFields(await readOpenBody(request));
}

export async function parseOpenPrepareRequest(request: Request) {
  const fields = await readOpenBody(request);
  return { ...parseOpenFields(fields), nftMint: parseClientNftMint(fields.nftMint).toBase58() };
}
