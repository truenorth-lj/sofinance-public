export type WalletFieldIntent = "auto" | "manual" | "url";

export type WalletFieldState = {
  value: string;
  intent: WalletFieldIntent;
};

export type ListedPosition = {
  positionMint: string;
  mintA: string;
  mintB: string;
  tickLower: number;
  tickUpper: number;
  rangeSide: string;
  decimalsA?: number;
  decimalsB?: number;
  feeTierBps?: number | null;
  symbolA?: string | null;
  symbolB?: string | null;
};

function firstQueryValue(value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return (value ?? "").trim();
}

/** Read `?mint=` / `?wallet=` (and `positionMint` as an alias). */
export function parsePerformanceQuery(search: {
  mint?: string | string[] | null;
  wallet?: string | string[] | null;
  positionMint?: string | string[] | null;
}): { mint: string; wallet: string } {
  return {
    mint: firstQueryValue(search.mint) || firstQueryValue(search.positionMint),
    wallet: firstQueryValue(search.wallet),
  };
}

/** Client URL (`useSearchParams`) — not the prerendered page `searchParams` prop. */
export function queryFromSearchParams(searchParams: {
  get: (name: string) => string | null;
}): { mint: string; wallet: string } {
  return parsePerformanceQuery({
    mint: searchParams.get("mint"),
    wallet: searchParams.get("wallet"),
    positionMint: searchParams.get("positionMint"),
  });
}

export function createWalletField(urlWallet: string): WalletFieldState {
  const value = urlWallet.trim();
  return value ? { value, intent: "url" } : { value: "", intent: "auto" };
}

export function initialWalletField(
  urlWallet: string,
  connectedAddress: string | undefined,
): WalletFieldState {
  const fromUrl = createWalletField(urlWallet);
  if (fromUrl.intent === "url") return fromUrl;
  return syncWalletField(fromUrl, connectedAddress);
}

/** Autofill / clear only while the field is still tracking the connected wallet. */
export function syncWalletField(
  state: WalletFieldState,
  connectedAddress: string | undefined,
): WalletFieldState {
  if (state.intent === "url" || state.intent === "manual") return state;
  if (connectedAddress) {
    return state.value === connectedAddress ? state : { value: connectedAddress, intent: "auto" };
  }
  return state.value ? { value: "", intent: "auto" } : state;
}

export function editWalletField(value: string): WalletFieldState {
  return { value, intent: "manual" };
}

export function resetWalletFieldToConnected(connectedAddress: string): WalletFieldState {
  return { value: connectedAddress, intent: "auto" };
}

export function showUseConnectedWallet(
  fieldValue: string,
  connectedAddress: string | undefined,
): boolean {
  return Boolean(connectedAddress && fieldValue.trim() !== connectedAddress);
}

/** Resolve the displayed wallet without copying props/connection into effect state. */
export function resolveWalletField(options: {
  urlWallet: string;
  connectedAddress: string | undefined;
  manualValue: string | null;
  ignoreUrl: boolean;
}): WalletFieldState {
  if (options.manualValue !== null) return editWalletField(options.manualValue);
  if (options.urlWallet.trim() && !options.ignoreUrl) return createWalletField(options.urlWallet);
  return syncWalletField({ value: "", intent: "auto" }, options.connectedAddress);
}

export function parseListedPositions(body: unknown): ListedPosition[] {
  if (!body || typeof body !== "object") return [];
  const positions = (body as { positions?: unknown }).positions;
  if (!Array.isArray(positions)) return [];
  return positions.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const rec = item as Record<string, unknown>;
    if (typeof rec.positionMint !== "string" || !rec.positionMint) return [];
    const decimalsA = typeof rec.decimalsA === "number" && Number.isInteger(rec.decimalsA) ? rec.decimalsA : undefined;
    const decimalsB = typeof rec.decimalsB === "number" && Number.isInteger(rec.decimalsB) ? rec.decimalsB : undefined;
    const feeTierBps = typeof rec.feeTierBps === "number" && Number.isFinite(rec.feeTierBps) ? rec.feeTierBps : undefined;
    const symbolA = typeof rec.symbolA === "string" ? rec.symbolA : undefined;
    const symbolB = typeof rec.symbolB === "string" ? rec.symbolB : undefined;
    return [
      {
        positionMint: rec.positionMint,
        mintA: typeof rec.mintA === "string" ? rec.mintA : "",
        mintB: typeof rec.mintB === "string" ? rec.mintB : "",
        tickLower: typeof rec.tickLower === "number" ? rec.tickLower : 0,
        tickUpper: typeof rec.tickUpper === "number" ? rec.tickUpper : 0,
        rangeSide: typeof rec.rangeSide === "string" ? rec.rangeSide : "",
        ...(decimalsA !== undefined ? { decimalsA } : {}),
        ...(decimalsB !== undefined ? { decimalsB } : {}),
        ...(feeTierBps !== undefined ? { feeTierBps } : {}),
        ...(symbolA !== undefined ? { symbolA } : {}),
        ...(symbolB !== undefined ? { symbolB } : {}),
      },
    ];
  });
}
