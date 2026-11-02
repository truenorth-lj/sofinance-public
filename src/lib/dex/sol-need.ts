/**
 * SOL an open needs in the wallet before it starts (PR10): rent + network fees + temporary swap accounts + the reserve
 * every check keeps. Pure and shared, so the server's INSUFFICIENT_FUNDS check (meteora-dlmm `buildMeteoraSetup`) and the
 * open dialog's "not enough SOL" message add the same parts and cannot drift apart.
 */
export type OpenSolParts = {
  /** Rent the open sets aside (position + new token accounts + any shared account). */
  rentLamports: bigint;
  /** Base network fees of every signature of every step. */
  networkFeeLamports: bigint;
  /** Rent the swap legs may hold in temporary token accounts. */
  swapAccountsLamports: bigint;
  /** SOL every check leaves in the wallet (`MIN_SOL_LAMPORTS`). */
  reserveLamports: bigint;
};

/** The parts the quote sends so the browser can add them the same way (lamports as decimal strings). */
export type OpenSolQuote = { networkFeeLamports: string; swapAccountsLamports: string; reserveLamports: string };

export const openSolNeed = (parts: OpenSolParts): bigint =>
  parts.rentLamports + parts.networkFeeLamports + parts.swapAccountsLamports + parts.reserveLamports;

/** SOL still missing (0n when the wallet has enough). */
export const openSolShortfall = (walletLamports: bigint, parts: OpenSolParts): bigint => {
  const need = openSolNeed(parts);
  return walletLamports < need ? need - walletLamports : 0n;
};

const lamports = (value: string | undefined) => (value && /^\d+$/.test(value) ? BigInt(value) : 0n);

/** The quote's parts with the rent the dialog shows. */
export const openSolPartsFromQuote = (rentLamports: bigint, sol: OpenSolQuote | undefined): OpenSolParts => ({
  rentLamports, networkFeeLamports: lamports(sol?.networkFeeLamports),
  swapAccountsLamports: lamports(sol?.swapAccountsLamports), reserveLamports: lamports(sol?.reserveLamports),
});
