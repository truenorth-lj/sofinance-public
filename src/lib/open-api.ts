import "server-only";

import { PublicKey } from "@solana/web3.js";
import { parseAddToleranceBps } from "./amount";
import { parseWallet } from "./api-input";
import { DEFAULT_OPEN_RANGE_PRESET, type OpenRangeInput, type OpenRangePreset } from "./open-range";
import type { OpenPositionSelection } from "./open-state";

const PRESETS = new Set<OpenRangePreset>(["tight", "standard", "wide", "custom"]);

export function parseOpenRange(fields: Record<string, unknown>): OpenRangeInput {
  const preset = (typeof fields.rangePreset === "string" ? fields.rangePreset : DEFAULT_OPEN_RANGE_PRESET) as OpenRangePreset;
  if (!PRESETS.has(preset)) throw new Error("Range preset must be tight, standard, wide, or custom");
  if (preset === "custom") {
    if (typeof fields.minPrice !== "string" || typeof fields.maxPrice !== "string") {
      throw new Error("Custom range requires minPrice and maxPrice (B per 1 A)");
    }
    return { preset: "custom", minPrice: fields.minPrice, maxPrice: fields.maxPrice };
  }
  return { preset };
}

export async function parseOpenQuoteRequest(request: Request) {
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid open-position input");
  const fields = body as Record<string, unknown>;
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
  return {
    wallet, selection, amount: fields.amount, range: parseOpenRange(fields),
    toleranceBps: parseAddToleranceBps(fields.slippageToleranceBps ?? fields.toleranceBps),
  };
}
