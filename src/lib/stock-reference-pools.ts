/**
 * Reference stock/USDC pool per stock mint, for the deposit-time entry price (`stock-entry-price-lookup.ts`).
 * Static on purpose: nothing looks a pool up at read time (no GeckoTerminal, CoinGecko or DexScreener on a position read).
 *
 * Listed: the base side of every same-stock pair in `/api/rwa-pairs` on 2026-11-10, i.e. the plain-ticker mint whose units
 * the report's share amounts use (NVDA in NVDA/NVDAx), so its price needs no conversion. Generated offline:
 * - pool: the deepest USDC pool by DexScreener liquidity among Raydium CLMM, Orca Whirlpool and Meteora DLMM, at least $25k;
 * - vaults: decoded from the pool account itself (mint/vault fields), never "a USDC account the pool owns": several Raydium
 *   pools also own a USDC reward vault.
 * A base mint that is not listed has no entry price ("not recorded").
 *
 * Row: [mint, symbol, protocol, pool, stockVault, usdcVault].
 */
export type StockReferencePool = {
  mint: string;
  symbol: string;
  protocol: "raydium-clmm" | "orca-whirlpool" | "meteora-dlmm";
  pool: string;
  stockVault: string;
  usdcVault: string;
};
type Row = readonly [mint: string, symbol: string, protocol: StockReferencePool["protocol"], pool: string, stockVault: string, usdcVault: string];

export const USDC_DECIMALS = 6;

const ROWS: readonly Row[] = [
  ["AAPLEDt8RpzPgXyhvFzkMBofvFSQw9gpeMCoUdPdLnB8", "AAPL", "raydium-clmm", "EJreqSHEfEP2JkKJFfKzHF7gqW3W6PwsaZrNTStWRDT7", "a6fhyrCxvUzwjLucJ6ushNgbAZjUQf6yBWYfGUtZppP", "5vRZwier5LrD7tK59Y81GtyssAnKiFeJ1JpEcd5V6AYQ"], // $304k liquidity, $104k 24h volume
  ["AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES", "AMD", "raydium-clmm", "ASvFi45yphKhx6ej9gJEDvTedXcXjhKjkhm3hRERuU2", "7RLoqcQDnBqQnhVUZ2BBrWJ8fiUgeW2NEnxueXdFBhVd", "58myx9bPyFNcpX9RhEpr9w5vHnGqPPoGBwiBCW3zJwih"], // $227k liquidity, $1,735k 24h volume
  ["AMZNw7cwU9L9c7ewZXxTws2PwQYxBGm2Rxg3FLDBJz9B", "AMZN", "orca-whirlpool", "7HZrWQE8o4dtC5XPNsRuWLKbgz5oRJCfZEbfdjkY8e1S", "DcQQ9wuSAiuTNVgMZBTKNthk5d7S41DaaUhLczn4A1LM", "5rD5JJKWs4SZvNfqchSss1JQxjvNeKf3fu1zzY7dWf4u"], // $310k liquidity, $82k 24h volume
  ["AVGoo4BQGsEfAmu4HU2deZTaTmLoqB3q3EzKXqAANGYD", "AVGO", "raydium-clmm", "4bx8rbxS783kf6CSY6SEMMDcd9UdoAJS3DpKdfmBa8XL", "7PTcN6sRxPtECWLtdUwCUoPa1mdRMGtCdXdoHxbCpLDL", "2RsoAK1NzEhzb9BUWBWFDD8bYAhu3cLdx8g7SaxPSwYk"], // $50k liquidity, $26k 24h volume
  ["GooGLMvZtJZXHdNZy95RUrAMCCKxV6ghK3qE5ddBgVm5", "GOOGL", "meteora-dlmm", "JCTYQ5RdzEe9zFTbzhHDRaAMrLW5EY99wAiwpGYmnqNp", "F3ocZccEDL19ANwzVf7PkWu6M7VYe1gHzzLgzCu4kTZf", "E8BWoZGnA6MNTJ7U2JAz9scgv7uZWpMizaRXLFZnBak2"], // $187k liquidity, $44k 24h volume
  ["HooDYv5RewLRiMLnEVq3VJqdqxhuE6c5eYvqejMC3e9A", "HOOD", "raydium-clmm", "97r9NLqYoyGFbQesPduwuTHq4fJjbk8pHVUGawEqfnva", "5hoBZjHqVTbPrJkdxPEaRSp9fBoRxo6YjthFXEiwPCEZ", "oopdSJ1bKbfhucqcKbWaz6TsgxqCjG66ATTMDeEKNmG"], // $230k liquidity, $84k 24h volume
  ["iNTCy1qTsUEZQe3DSocLz1ZXXai34Gdw8THQh5rxFaF", "INTC", "raydium-clmm", "HHNPd8DpneXbaYBiGC7SU28mYxocbkMznPABPN3sGTyU", "3xsWZgh9pVdgfUL8jBWSXnr5nqqooc34s45RXmNZyfJ7", "M8uyBD7th2SSK7GYGDxDBcV9i8XtTDBhwSmXczAYd67"], // $182k liquidity, $121k 24h volume
  ["METAaH6MMZZgy2CTEJq3QdNi7AFVTV3NxHFBfFgLEDd", "META", "orca-whirlpool", "Ba5EzSmhTb5frEcuSvUkd7VuRWm1areu3BWiQiAbKqyB", "D8w3nFWzFixsG3mZrbUQ6dPfTuMRY3vWFjbrJoRgRGEw", "AGH9veq1xWpQWRQe35hioVu1cJmK2hd9gjoxcG6XLzAX"], // $913k liquidity, $268k 24h volume
  ["MSTRdWXMeZxdE8osAQy3fA4rvTY5rgummDSMEx6U7Nz", "MSTR", "raydium-clmm", "3Hro9bWkxiyV7ZfH2ZBdqyuNEVZt69ixNyQbAmcvyvys", "3euLMb83drVoT8g8Kb4zRZ7SCHdaJ7csKHs6YXgLbo6F", "83xhxSvpC6ASuZFCA1tZA9UgqeXLA4x7XojrADwYHEUv"], // $295k liquidity, $197k 24h volume
  ["NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv", "NVDA", "orca-whirlpool", "3Vj5gFHtctCTLU3u6XAjncjo5mKjAiD6VYU8dSNFL4mb", "FrHBntwL1o5M6GhoPgxi7hcYntbsqn1eG4sx3pTGLmaH", "59xWGxHfcNJsHPcuTmdpN6FRqh2ev3sEdHBNdNH6MH96"], // $412k liquidity, $1,996k 24h volume
  ["SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3", "SKHY", "meteora-dlmm", "DPAU7wDyMXDgNAfzQYMfyNqmTjzcoRsSPA2LeGH71hgi", "Dmtns8dg9zo3oVFymmL5XtTrY7uggRYyv4UiJ7h22aFf", "Ex81ox18eQKknBTewULzvKZo5F2KBkWNwXfV8ammPnL1"], // $2,306k liquidity, $2,430k 24h volume
  ["SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH", "SNDK", "raydium-clmm", "4vRC6Qne8HPUN98mJr88vRkRD9N4cadyrGtPwVU3CV86", "AWbFvUw6WJENp6QWA4SKNa9xmy4BVVSetSe1CLags5Zp", "FpipF7qkdHm7TKGvhTbYt3t5hyBVqwRJCpVTBzvwRje7"], // $76k liquidity, $243k 24h volume
  ["SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb", "SPCX", "raydium-clmm", "FjuBy7jjf9DXj9d3R7cHpvcnoFW2iQxf7F7P3vqx4Jza", "2iM4Qur7sY2cPWRvfDjQbw2u7WZuHVgWicGGaMoYjJn8", "FqRgdh1hE1YggkMRDvyf3HRpceUqoBdBTwmRHieiz2Kt"], // $2,344k liquidity, $4,122k 24h volume
  ["SPYBo66VJPFjh1pXMb9Le53kDYWTK1zzYVDeVRWtsbi", "SPY", "raydium-clmm", "GhUirLuWhXoHfyTGadP8R6BUJXVqQPvq6VankLmiHAKv", "94ja4mKbwKBN74vKepWmr6iuQ7Kf64eMnfca1bYc77Ns", "BBPGpzeLR9VFNVWtvDA6oEt4S1JKLWrXPxu3nfhadDMv"], // $188k liquidity, $92k 24h volume
  ["TSLAqBbv4CNCnzWFeB7LmydAyEiNMJtve7DYKLpdK4S", "TSLA", "orca-whirlpool", "4hZm9mBGP4A8hXM9TB7DnfqfYT7qrXr58q8jYXcXLDo3", "3TibzWnfCEnh3u1CTToJH4N8ifA5fTw2LUKAFJigrmtk", "7GBHsg148xXbi7rTXcphS9bDomdYRmrximnsVyknP8mG"], // $925k liquidity, $391k 24h volume
];

const STOCK_REFERENCE_POOLS: ReadonlyMap<string, StockReferencePool> = new Map(ROWS.map(
  ([mint, symbol, protocol, pool, stockVault, usdcVault]) => [mint, { mint, symbol, protocol, pool, stockVault, usdcVault }]));

export function stockReferencePool(mint: string): StockReferencePool | null {
  return STOCK_REFERENCE_POOLS.get(mint) ?? null;
}
