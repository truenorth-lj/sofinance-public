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

/** Plain-English reason the dialog shows (and blocks Open) when the quote lacks the SOL parts. */
export const SOL_NEED_UNKNOWN_COPY =
  "Can't work out how much SOL this open needs (the quote did not include network fees, temporary swap accounts and the reserve), so it is blocked to avoid running out of SOL midway. Try again in a moment.";

/** Either every part of the open's SOL need, or why it can't be computed (never a partial, underestimated sum). */
export type OpenSolPartsResult = { ok: true; parts: OpenSolParts } | { ok: false; reason: string };

const lamports = (value: string | undefined): bigint | null => (typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null);

/** The quote's parts with the rent the dialog shows; a missing or malformed part means "cannot compute", not 0. */
export const openSolPartsFromQuote = (rentLamports: bigint, sol: OpenSolQuote | undefined): OpenSolPartsResult => {
  const networkFeeLamports = lamports(sol?.networkFeeLamports);
  const swapAccountsLamports = lamports(sol?.swapAccountsLamports);
  const reserveLamports = lamports(sol?.reserveLamports);
  if (networkFeeLamports === null || swapAccountsLamports === null || reserveLamports === null) return { ok: false, reason: SOL_NEED_UNKNOWN_COPY };
  return { ok: true, parts: { rentLamports, networkFeeLamports, swapAccountsLamports, reserveLamports } };
};
