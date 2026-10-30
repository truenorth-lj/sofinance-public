/**
 * Token icon links stored by the daily rwa-refresh job (`rwa_token_icon`) and served with `/api/rwa-pairs`
 * (`tokenIcons`). Client-safe: no fetching here. Only links are stored; images are never copied.
 */
export type IconChain = "solana" | "robinhood";
export type IconSource = "jupiter" | "raydium" | "dexscreener" | "geckoterminal" | "manual";
export type TokenIconRow = { chain: IconChain; address: string; image: string; source: IconSource };
/** chain → token address (Solana mint as-is, Robinhood Chain lowercase 0x) → icon URL. */
export type TokenIconMap = Record<IconChain, Record<string, string>>;

export const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

/** Robinhood Chain addresses are stored lowercase; Solana mints are case-sensitive. */
export function iconAddress(chain: IconChain, address: string): string {
  return chain === "robinhood" ? address.toLowerCase() : address;
}

export function validIconAddress(chain: IconChain, address: string): boolean {
  return chain === "solana" ? SOLANA_MINT.test(address) : EVM_ADDRESS.test(address);
}

const xstock = (mint: string, symbol: string): TokenIconRow =>
  ({ chain: "solana", address: mint, image: `https://xstocks-metadata.backed.fi/logos/tokens/${symbol}.png`, source: "manual" });

/**
 * Last-resort icons when neither indexer lists one, starting with the xStock tokens (issuer logo CDN) and the
 * Robinhood Chain SPCX / SPCXon pair (DexScreener lists no image for either; the SpaceX logo stands for the stock).
 * Every entry is on `ICON_HOSTS` (tested).
 */
export const MANUAL_TOKEN_ICONS: readonly TokenIconRow[] = Object.freeze([
  xstock("Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8", "SPCXx"),
  xstock("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", "TSLAx"),
  xstock("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", "AAPLx"),
  xstock("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", "NVDAx"),
  xstock("XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", "GOOGLx"),
  xstock("Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", "AMZNx"),
  xstock("Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", "METAx"),
  xstock("XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", "MSTRx"),
  xstock("XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg", "HOODx"),
  xstock("XsXcJ6GZ9kVnjqGsjBnktRcuwMBmvKWh8S93RefZ1rF", "AMDx"),
  xstock("XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo", "AVGOx"),
  xstock("XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM", "INTCx"),
  xstock("XsnhgGRQwhExfS2bmWzR6EYddKGPRGDEjeJsatkmKqU", "SKHYx"),
  xstock("Xswbpc8UqU6e1j9QZEWCjBMjyvz4twqD7PCy6j2e7jj", "SNDKx"),
  { chain: "robinhood", address: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", image: "https://s3-symbol-logo.tradingview.com/spacex.svg", source: "manual" },
  { chain: "robinhood", address: "0x9b8294f24453379aa87c807ab82bf1d5722153fc", image: "https://s3-symbol-logo.tradingview.com/spacex.svg", source: "manual" },
]);

export const emptyIconMap = (): TokenIconMap => ({ solana: {}, robinhood: {} });

/** Map from stored rows, with the manual list filling only tokens the database has no icon for. */
export function tokenIconMap(rows: readonly TokenIconRow[], manual: readonly TokenIconRow[] = MANUAL_TOKEN_ICONS): TokenIconMap {
  const map = emptyIconMap();
  for (const row of manual) map[row.chain][iconAddress(row.chain, row.address)] = row.image;
  for (const row of rows) map[row.chain][iconAddress(row.chain, row.address)] = row.image;
  return map;
}

/** Icon for one token from an `/api/rwa-pairs` `tokenIcons` value (missing or malformed → null). */
export function iconFor(map: Partial<TokenIconMap> | null | undefined, chain: IconChain, address: string): string | null {
  const entry = map?.[chain]?.[iconAddress(chain, address)];
  return typeof entry === "string" && entry.startsWith("https://") ? entry : null;
}
