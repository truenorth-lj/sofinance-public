/**
 * Vitest setup (listed first in vitest.config.mts): the app's unit tests never reach the network through `fetch`.
 *
 * It runs before any test module loads, so libraries that keep their own copy of `fetch` from load time (e.g.
 * @solana/web3.js's `fetchImpl`, used by every `Connection` without a custom fetch) hold this guard, not the real
 * fetch. Tests that stub `globalThis.fetch` (vi.spyOn / vi.stubGlobal) keep working; code that captured the guard is
 * routed through `setFetchReplay`, which the DEX contract suite uses for its recorded replays. Loopback hosts stay
 * reachable for local test servers.
 */
type FetchArgs = Parameters<typeof fetch>;
type FetchReplay = (...args: FetchArgs) => Promise<Response>;
type OfflineFetchState = { realFetch: typeof fetch; guard: typeof fetch; replay?: FetchReplay };

const STATE = Symbol.for("sofinance.test.offline-fetch");
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function urlOf(input: FetchArgs[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

export class OfflineFetchError extends Error {
  constructor(readonly host: string) {
    super(`Network access to ${host} is blocked in unit tests: mock fetch or record a fixture replay`);
    this.name = "OfflineFetchError";
  }
}

function state(): OfflineFetchState {
  const holder = globalThis as unknown as Record<symbol, OfflineFetchState | undefined>;
  const existing = holder[STATE];
  if (existing) return existing;
  const created: OfflineFetchState = {
    realFetch: globalThis.fetch,
    guard: async (...args: FetchArgs) => {
      const current = state();
      if (current.replay) return current.replay(...args);
      let url: URL | undefined;
      try { url = new URL(urlOf(args[0])); } catch { /* fall through: not an absolute URL */ }
      if (url && LOOPBACK_HOSTS.has(url.hostname)) return current.realFetch(...args);
      throw new OfflineFetchError(url?.host ?? "(invalid url)");
    },
  };
  holder[STATE] = created;
  return created;
}

/** Installs the guard as `globalThis.fetch` (idempotent across test files in one worker). */
export function installOfflineFetch(): void {
  globalThis.fetch = state().guard;
}

/**
 * Routes every fetch that reaches the guard (including copies captured at module load) to `replay` until the returned
 * restore function runs.
 */
export function setFetchReplay(replay: FetchReplay): () => void {
  const current = state();
  const previous = current.replay;
  current.replay = replay;
  return () => { current.replay = previous; };
}

installOfflineFetch();
