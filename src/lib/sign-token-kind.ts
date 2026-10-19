import { inflateSync } from "zlib";
import type { PendingSignKind } from "./pending-sign-token";

/**
 * Read the `kind` of a sign token WITHOUT verifying its HMAC. Used only by the region gate to let
 * restricted-region visitors open withdrawal sign links. That is safe: a forged "withdraw" kind
 * only reaches the sign page, and the broadcast route it would call still verifies the token's
 * permit and refuses non-withdraw transactions from restricted regions server-side.
 */
export function unverifiedSignTokenKind(token: string): PendingSignKind | null {
  try {
    const data = token.split(".")[1];
    if (!data || data.length > 64_000) return null;
    const json = inflateSync(Buffer.from(data, "base64url"), { maxOutputLength: 512_000 }).toString("utf8");
    const kind = (JSON.parse(json) as { kind?: unknown }).kind;
    return kind === "add-liquidity" || kind === "compound" || kind === "open-position" || kind === "withdraw" ? kind : null;
  } catch {
    return null;
  }
}
