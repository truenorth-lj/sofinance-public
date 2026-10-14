/** Both runtime and migration must remain confined to the dedicated role/database. */
export function validateRwaTarget(url: string) {
  try {
    const target = new URL(url);
    if (!["postgres:", "postgresql:"].includes(target.protocol) ||
      decodeURIComponent(target.username) !== "sofinance" || target.pathname !== "/sofinance") throw new Error();
  } catch { throw new Error("Use the dedicated sofinance database and role"); }
}
