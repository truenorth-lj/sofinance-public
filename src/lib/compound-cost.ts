export function tokenUsdValue(raw: string, decimals: number, price: number | null | undefined): number | null {
  if (BigInt(raw) === 0n) return 0;
  if ((price === null || price === undefined) || !Number.isFinite(price) || price <= 0) return null;
  const value = Number(raw) / 10 ** decimals * price;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatUsdcValue(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "USDC estimate unavailable";
  if (value === 0) return "0 USDC";
  if (value < 0.000001) return "< 0.000001 USDC";
  return `${value.toFixed(value < 0.01 ? 6 : 4).replace(/0+$/, "").replace(/\.$/, "")} USDC`;
}
