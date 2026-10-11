// Mints /app/sign/<token> tokens exactly like src/lib/pending-sign-token.ts (deflate + base64url + HMAC-SHA256),
// so the hermetic lane does not need the server to prepare anything. The secret is the CI-only dummy value that
// the test server is started with (JUPITER_API_KEY is the signing secret today). Never use a real key here.
import { createHmac } from "node:crypto";
import { deflateSync } from "node:zlib";

export type SignKind = "add-liquidity" | "compound" | "open-position";
export type SignPayload = {
  kind: SignKind;
  wallet: string;
  unsignedTransaction: string;
  permit: string;
  submitArgs: Record<string, unknown>;
  expiresAt: number;
};

export const E2E_SIGNING_SECRET = process.env.E2E_SIGNING_SECRET ?? "e2e-ci-only-not-a-secret";

export function mintSignToken(payload: SignPayload, secret = E2E_SIGNING_SECRET): string {
  const data = deflateSync(Buffer.from(JSON.stringify(payload), "utf8")).toString("base64url");
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${signature}.${data}`;
}

/** Flip one character inside the signed data part: the HMAC no longer matches. */
export function tamperToken(token: string): string {
  const dot = token.indexOf(".");
  const data = token.slice(dot + 1);
  const mid = Math.floor(data.length / 2);
  const flipped = data[mid] === "A" ? "B" : "A";
  return `${token.slice(0, dot + 1)}${data.slice(0, mid)}${flipped}${data.slice(mid + 1)}`;
}
