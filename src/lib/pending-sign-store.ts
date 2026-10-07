/**
 * In-memory pending sign payload store for demo.
 * 
 * Works on Vercel Hobby without KV. Each payload expires quickly (matches permit/blockhash lifetime).
 * For production multi-instance deploys, replace with Vercel KV or similar.
 */

export type PendingSignKind = "add-liquidity" | "compound";

export interface PendingSignPayload {
  id: string;
  kind: PendingSignKind;
  wallet: string;
  unsignedTransaction: string;
  permit: string;
  submitArgs: Record<string, unknown>;
  expiresAt: number;
  createdAt: number;
}

const store = new Map<string, PendingSignPayload>();

const TTL_MS = 120_000;

function cleanup() {
  const now = Date.now();
  for (const [id, payload] of store.entries()) {
    if (now >= payload.expiresAt) {
      store.delete(id);
    }
  }
}

setInterval(cleanup, 30_000);

function generateId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function storePendingSign(
  kind: PendingSignKind,
  wallet: string,
  unsignedTransaction: string,
  permit: string,
  submitArgs: Record<string, unknown>,
  permitExpiresAt: number
): string {
  cleanup();
  
  const id = generateId();
  const now = Date.now();
  const expiresAt = Math.min(now + TTL_MS, permitExpiresAt);
  
  const payload: PendingSignPayload = {
    id,
    kind,
    wallet,
    unsignedTransaction,
    permit,
    submitArgs,
    expiresAt,
    createdAt: now,
  };
  
  store.set(id, payload);
  return id;
}

export function retrievePendingSign(id: string): PendingSignPayload | null {
  cleanup();
  
  const payload = store.get(id);
  if (!payload) return null;
  
  const now = Date.now();
  if (now >= payload.expiresAt) {
    store.delete(id);
    return null;
  }
  
  return payload;
}

export function deletePendingSign(id: string): void {
  store.delete(id);
}
