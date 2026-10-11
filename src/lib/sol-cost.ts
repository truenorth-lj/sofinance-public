import { formatAmount } from "./amount";

export function formatSolCost(lamports: string | number | bigint, rate: number | null): string {
  const sol = formatAmount(String(lamports), 9, 9);
  const value = Number(lamports) / 1e9 * (rate ?? NaN);
  if (rate === null || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(value) || value < 0) {
    return `${sol} SOL (USDC estimate unavailable)`;
  }
  const usdc = value === 0 ? "0" : value < 0.000001 ? "< 0.000001" : value.toFixed(value < 0.01 ? 6 : 4).replace(/0+$/, "").replace(/\.$/, "");
  return `${sol} SOL (≈ ${usdc} USDC)`;
}
