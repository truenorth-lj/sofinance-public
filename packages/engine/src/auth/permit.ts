import { createHmac, timingSafeEqual } from "node:crypto";

export type PermitInput = { wallet: string; message: string; summary: unknown };

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/**
 * HMAC permit bound to a domain string, e.g. "sofinance:open-position:v1".
 * The signed payload is `${domain}:${canonical({ wallet, message, summary })}`, so an approval
 * issued for one domain can never be replayed as another. The domain strings are part of the
 * wire contract (golden vectors in lib/permit-golden.test.ts): changing one invalidates every
 * outstanding permit.
 */
export function createPermit(domain: string) {
  function issue(secret: string, input: PermitInput) {
    if (!secret) throw new Error("Missing server signing key");
    return createHmac("sha256", secret).update(`${domain}:${canonical(input)}`).digest("hex");
  }
  function verify(secret: string, input: PermitInput, permit: unknown) {
    if (typeof permit !== "string" || !/^[0-9a-f]{64}$/.test(permit)) return false;
    const expected = Buffer.from(issue(secret, input), "hex");
    return timingSafeEqual(expected, Buffer.from(permit, "hex"));
  }
  return { issue, verify };
}
