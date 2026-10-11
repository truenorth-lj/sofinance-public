/**
 * Short "company + issuer" line for a pair card, built from the two token names.
 *
 *   "Robinhood xStock" / "Robinhood Markets - Backpack Securities"  →  "Robinhood xStock / Backpack"
 *   "SpaceX - Backpack Securities" / "SpaceX xStock"                →  "SpaceX Backpack / xStock"
 *
 * The company is named once (from the first token) and each side keeps only its issuer. Names that do not
 * follow "<Company> xStock" or "<Company> - <Issuer> [Securities]" are shown in full.
 */
function parseTokenName(name: string): { company: string; issuer: string } | null {
  const text = name.trim();
  const xstock = /^(.+?)\s+xStock$/i.exec(text);
  if (xstock) return { company: xstock[1]!, issuer: "xStock" };
  const dashed = /^(.+?)\s+-\s+(.+?)(?:\s+Securities)?$/i.exec(text);
  if (dashed) return { company: dashed[1]!, issuer: dashed[2]! };
  return null;
}

export function pairIssuerLabel(nameA: string, nameB: string): string {
  const a = parseTokenName(nameA);
  const b = parseTokenName(nameB);
  return a && b ? `${a.company} ${a.issuer} / ${b.issuer}` : `${nameA} / ${nameB}`;
}
