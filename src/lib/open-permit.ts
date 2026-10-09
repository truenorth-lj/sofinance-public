import { createHmac, timingSafeEqual } from "node:crypto";

type PermitInput = { wallet: string; message: string; summary: unknown };

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

// Canonical JSON of { wallet, message, summary } so a recovery/add/compound
// approval cannot be replayed as an open-position approval.
export function issueOpenPositionPermit(secret: string, input: PermitInput) {
  if (!secret) throw new Error("Missing server signing key");
  return createHmac("sha256", secret).update(`sofinance:open-position:v1:${canonical(input)}`).digest("hex");
}

export function verifyOpenPositionPermit(secret: string, input: PermitInput, permit: unknown) {
  if (typeof permit !== "string" || !/^[0-9a-f]{64}$/.test(permit)) return false;
  const expected = Buffer.from(issueOpenPositionPermit(secret, input), "hex");
  return timingSafeEqual(expected, Buffer.from(permit, "hex"));
}
