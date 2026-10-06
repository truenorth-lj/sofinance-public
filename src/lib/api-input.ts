import { PublicKey } from "@solana/web3.js";
import { parseAddToleranceBps, parseResaleFloorBps } from "./amount";
import type { PositionSelection } from "./selected-state";

export function parseWallet(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid wallet address");
  try {
    const key = new PublicKey(value);
    if (PublicKey.isOnCurve(key.toBytes())) return key.toBase58();
  } catch { /* Invalid base58 is reported with the same public message. */ }
  throw new Error("Invalid wallet address");
}

export async function parseSelectedQuoteRequest(request: Request) {
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid quote input");
  const fields = body as Record<string, unknown>;
  const wallet = parseWallet(fields.wallet);
  if (typeof fields.positionMint !== "string" || typeof fields.inputMint !== "string") throw new Error("Invalid asset or position mint");
  let positionMint: string;
  let inputMint: string;
  try {
    positionMint = new PublicKey(fields.positionMint).toBase58();
    inputMint = new PublicKey(fields.inputMint).toBase58();
  } catch { throw new Error("Invalid asset or position mint"); }
  if (fields.inputKind !== "native" && fields.inputKind !== "token") throw new Error("Invalid input asset type");
  if (typeof fields.amount !== "string" || fields.amount.length > 40) throw new Error("Invalid input amount");
  const selection: PositionSelection = { positionMint, inputMint, inputKind: fields.inputKind };
  return { wallet, selection, amount: fields.amount, floorBps: parseResaleFloorBps(fields.floorBps),
    toleranceBps: parseAddToleranceBps(fields.toleranceBps) };
}
