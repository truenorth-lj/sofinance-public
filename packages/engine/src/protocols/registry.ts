import { raydiumClmmAdapter } from "./raydium";
import { DEFAULT_PROTOCOL, PROTOCOL_IDS, type ClmmProtocolAdapter, type ProtocolId } from "./types";

const adapters: Readonly<Record<ProtocolId, ClmmProtocolAdapter>> = Object.freeze({
  "raydium-clmm": raydiumClmmAdapter,
});

export function isProtocolId(value: unknown): value is ProtocolId {
  return typeof value === "string" && (PROTOCOL_IDS as readonly string[]).includes(value);
}

/** Resolve a protocol id; a missing id means the historical default (Raydium CLMM). */
export function parseProtocolId(value: unknown): ProtocolId {
  if (value === undefined || value === null || value === "") return DEFAULT_PROTOCOL;
  if (!isProtocolId(value)) throw new Error(`Unsupported protocol: ${String(value)}`);
  return value;
}

export function getProtocolAdapter(protocol: ProtocolId = DEFAULT_PROTOCOL): ClmmProtocolAdapter {
  return adapters[protocol];
}

/** The adapter whose on-chain program owns a pool or position account, if any. */
export function protocolForProgramId(programId: string): ClmmProtocolAdapter | null {
  return Object.values(adapters).find(adapter => adapter.programId.toBase58() === programId) ?? null;
}
