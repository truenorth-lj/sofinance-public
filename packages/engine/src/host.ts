// Host injection point for @sofinance/engine.
//
// The engine never reads `process.env` (or any other ambient configuration) itself. The host
// application calls `configureEngine()` once at startup with a function that returns the current
// configuration values; the engine calls it on every read, so hosts that rotate a key or stub a
// value in a test see the change immediately (the same semantics the engine had when it read
// `process.env` inline).
//
// Keys the engine currently understands (all optional unless a feature needs them):
//   JUPITER_API_KEY, E2E_KEYLESS_JUPITER, JUPITER_* (base URLs / logging),
//   SOFINANCE_FEE_WALLET, SOFINANCE_FEE_BPS,
//   SOLAMI_API_KEY, SOLANA_RPC_URL, SOLAMI_* / RPC_* (provider selection, logging),
//   SOLAMI_BEAM_* (Beam tip acceleration).
// RPC connections can also be injected per call (every builder accepts a `connection` option).

export type EngineEnv = Readonly<Record<string, string | undefined>>;

export type EngineHost = {
  /** Returns the configuration snapshot to use for this read. Called on every read. */
  env: () => EngineEnv;
};

let host: EngineHost | null = null;

/** Install (or replace) the host configuration provider. Idempotent. */
export function configureEngine(next: EngineHost) {
  host = next;
}

/** Test helper: forget the configured host. */
export function resetEngineHost() {
  host = null;
}

export function isEngineConfigured() {
  return host !== null;
}

/** Current configuration. Throws when the host forgot to call `configureEngine()`. */
export function engineEnv(): EngineEnv {
  if (!host) throw new Error("@sofinance/engine is not configured: call configureEngine({ env }) before using it");
  return host.env();
}
