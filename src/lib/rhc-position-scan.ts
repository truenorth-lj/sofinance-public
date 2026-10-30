import "@/lib/engine-host";
import "server-only";

import { robinhoodChain, ROBINHOOD_PUBLIC_RPC_URL } from "@sofinance/engine/chains/robinhood";
import {
  type HoldingsState, readHeldPositions, scanHoldings, type ScannedPosition,
} from "@sofinance/engine/protocols/uniswap-v4/position-scan";
import { type Address, createPublicClient, http, type PublicClient, type Transport } from "viem";
import { ThrottleGate } from "@/lib/range-apr/throttle-gate";

/**
 * Server side of "find the Robinhood Chain v4 positions this wallet holds" (`GET /api/rhc-univ4-positions`).
 *
 * RPC: only the official public endpoint (PM 2026-10-30: free, serves eth_getLogs over wide ranges with a
 * User-Agent). Never the paid `RHC_RPC_URL` and never the shared `createRhcClient` budgets.
 *
 * Cache (per server instance): per wallet, the folded Transfer state with `scannedTo` (so a later scan only covers
 * new blocks) and the last result for `RESULT_TTL_MS`. Concurrent requests for one wallet share one scan; a failure
 * is remembered for `FAILURE_TTL_MS`. All scans on an instance go through one gate (serialised, spaced RPC calls,
 * cooldown after a 429), so visitors never fan out onto the RPC.
 */

export const RHC_SCAN_USER_AGENT = "SoFinance/1.0 (+https://sofinancelab.xyz; rhc-positions-scan)";
export const RESULT_TTL_MS = 60_000;
export const FAILURE_TTL_MS = 15_000;
/** `fresh` requests (after an open / close) still reuse a result younger than this. */
export const FRESH_MIN_AGE_MS = 10_000;
const MAX_WALLETS = 500;
/** Start-to-start spacing of scan RPC calls (measured 2026-10-30: the official RPC answers 429 after ~20 calls at ~6/s). */
export const SCAN_CALL_SPACING_MS = 250;

export type RhcScanResult = {
  state: "scan";
  wallet: Address;
  positions: ScannedPosition[];
  scannedToBlock: string;
  checkedAt: number;
  /** RPC calls this request made (0 when served from the cache). */
  rpcCalls: number;
};

export class RhcScanBusyError extends Error {
  constructor(readonly retryAfterMs: number) { super("Robinhood Chain is busy right now"); this.name = "RhcScanBusyError"; }
}

type Entry = { holdings: HoldingsState | null; result: RhcScanResult | null; at: number; failure: { at: number; error: unknown } | null };

export type ScanDeps = { client?: PublicClient; now?: () => number };

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<RhcScanResult>>();
let gate = new ThrottleGate({ minSpacingMs: SCAN_CALL_SPACING_MS, defaultCooldownMs: 30_000 });
let calls = 0;

const is429 = (error: unknown) => /\b429\b|rate limit|too many requests/i.test(error instanceof Error ? `${error.message} ${(error as { details?: string }).details ?? ""}` : String(error));

/** viem client on the official RPC (or `inner`, in tests): every JSON-RPC call waits for the gate and is counted. */
export function createScanClient(inner: Transport = officialTransport()): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    batch: { multicall: false },
    transport: (config) => {
      const base = inner({ ...config, retryCount: 0 });
      return {
        ...base,
        request: (async (args: { method: string; params?: unknown }) => {
          const r = await gate.run(async () => {
            calls++;
            try { return await base.request(args as never); } catch (error) {
              if (is429(error)) gate.block();
              throw error;
            }
          });
          if ("blocked" in r) throw new RhcScanBusyError(r.blocked);
          return r.value;
        }) as typeof base.request,
      };
    },
  }) as PublicClient;
}

function officialTransport(): Transport {
  return http(ROBINHOOD_PUBLIC_RPC_URL, { timeout: 15_000, retryCount: 0, batch: false, fetchOptions: { headers: { "User-Agent": RHC_SCAN_USER_AGENT } } });
}

let client: PublicClient | null = null;

function remember(key: string, entry: Entry) {
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_WALLETS) entries.delete(entries.keys().next().value!);
}

/** Held positions for `wallet` (checksummed), from the cache when fresh. Throws on RPC failure (callers degrade). */
export async function scanRhcPositions(wallet: Address, options: { fresh?: boolean } = {}, deps: ScanDeps = {}): Promise<RhcScanResult> {
  const now = deps.now ?? Date.now;
  const key = wallet.toLowerCase();
  const entry = entries.get(key);
  const maxAge = options.fresh ? FRESH_MIN_AGE_MS : RESULT_TTL_MS;
  if (entry?.result && now() - entry.at < maxAge) return { ...entry.result, rpcCalls: 0 };
  if (entry?.failure && now() - entry.failure.at < FAILURE_TTL_MS) throw entry.failure.error;
  const running = inflight.get(key);
  if (running) return running.then(r => ({ ...r, rpcCalls: 0 }));

  const c = deps.client ?? (client ??= createScanClient());
  const task = (async () => {
    const before = calls;
    try {
      const head = await c.getBlockNumber({ cacheTime: 0 });
      const scanned = await scanHoldings(c, wallet, entry?.holdings ?? null, head);
      const positions = await readHeldPositions(c, wallet, scanned.candidates);
      // Keep only what the wallet still holds: a later return of an NFT is a new Transfer log, seen by the next scan.
      const holdings: HoldingsState = { scannedTo: scanned.scannedTo, candidates: positions.map(p => p.tokenId) };
      const result: RhcScanResult = { state: "scan", wallet, positions, scannedToBlock: holdings.scannedTo, checkedAt: now(), rpcCalls: calls - before };
      remember(key, { holdings, result, at: now(), failure: null });
      return result;
    } catch (error) {
      remember(key, { holdings: entry?.holdings ?? null, result: entry?.result ?? null, at: entry?.at ?? 0, failure: { at: now(), error } });
      throw error;
    }
  })();
  inflight.set(key, task);
  try { return await task; } finally { inflight.delete(key); }
}

/** RPC calls made through scan clients on this instance. */
export function scanRpcCallCount(): number { return calls; }

/* ---- request limit ---- */
const WINDOW_MS = 60_000;
export const REQUESTS_PER_IP_PER_MINUTE = 20;
const hits = new Map<string, number[]>();

export const RHC_SCAN_FAILED_MESSAGE = "Couldn't check this wallet's Robinhood Chain positions right now. Positions saved in this browser and added by number are still shown.";

/** Per-IP request limit (sliding minute, per instance). */
export function rhcScanRateLimited(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= REQUESTS_PER_IP_PER_MINUTE) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.delete(ip); hits.set(ip, recent);
  while (hits.size > 5_000) hits.delete(hits.keys().next().value!);
  return false;
}

/** Test hook. */
export function resetRhcScanCache(gateOptions: ConstructorParameters<typeof ThrottleGate>[0] = { minSpacingMs: SCAN_CALL_SPACING_MS, defaultCooldownMs: 30_000 }): void {
  entries.clear(); inflight.clear(); client = null; calls = 0; hits.clear();
  gate = new ThrottleGate(gateOptions);
}
