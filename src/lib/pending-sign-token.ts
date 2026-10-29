import { createHmac } from "crypto";
import { deflate, inflate } from "zlib";
import { promisify } from "util";

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

import type { OpenPositionSelection } from "@sofinance/engine/open-state";
import type { OpenRangeInput } from "@sofinance/engine/open-range";

export type PendingSignKind = "add-liquidity" | "compound" | "open-position" | "withdraw";

/**
 * MCP open without `nftMint`: the sign page generates the position NFT mint in the
 * browser and re-prepares with these HMAC-bound inputs, so the wallet signs first
 * and the mint signs the wallet-returned transaction. The server never holds the secret.
 */
export interface SignOpenRequest {
  selection: OpenPositionSelection;
  amount: string;
  range: OpenRangeInput;
  floorBps: number;
  toleranceBps?: number;
}

export interface PendingSignPayload {
  kind: PendingSignKind;
  wallet: string;
  unsignedTransaction: string;
  permit: string;
  submitArgs: Record<string, unknown>;
  expiresAt: number;
  /** Present only for open-position links created without `nftMint`. */
  openRequest?: SignOpenRequest;
}

function hmacSign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function hmacVerify(data: string, signature: string, secret: string): boolean {
  const expected = hmacSign(data, secret);
  return signature === expected;
}

export async function createSignToken(
  payload: PendingSignPayload,
  secret: string
): Promise<string> {
  const json = JSON.stringify(payload);
  const compressed = await deflateAsync(Buffer.from(json, "utf-8"));
  const data = compressed.toString("base64url");
  const signature = hmacSign(data, secret);
  return `${signature}.${data}`;
}

export async function verifySignToken(
  token: string,
  secret: string
): Promise<PendingSignPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    
    const [signature, data] = parts;
    if (!signature || !data) return null;
    
    if (!hmacVerify(data, signature, secret)) {
      return null;
    }
    
    const compressed = Buffer.from(data, "base64url");
    const decompressed = await inflateAsync(compressed);
    const payload = JSON.parse(decompressed.toString("utf-8")) as PendingSignPayload;
    
    if (!payload.kind || !payload.wallet || !payload.unsignedTransaction || 
        !payload.permit || !payload.submitArgs || !payload.expiresAt) {
      return null;
    }
    
    if (Date.now() >= payload.expiresAt) {
      return null;
    }
    
    return payload;
  } catch {
    return null;
  }
}
