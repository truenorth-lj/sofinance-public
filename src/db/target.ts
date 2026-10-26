export type RwaDatabaseRole = "sofinance" | "sofinance_owner";

export function validateRwaRole(role = "sofinance"): RwaDatabaseRole {
  if (role !== "sofinance" && role !== "sofinance_owner")
    throw new Error("Invalid expected RWA database role");
  return role;
}

/** Both runtime and migration remain confined to this database and an explicit approved role. */
export function validateRwaTarget(url: string, expectedRole: RwaDatabaseRole = "sofinance") {
  validateRwaRole(expectedRole);
  try {
    const target = new URL(url);
    if (!["postgres:", "postgresql:"].includes(target.protocol) || !target.hostname || target.hash ||
      decodeURIComponent(target.username) !== expectedRole || target.pathname !== "/sofinance") throw new Error();
  } catch { throw new Error("Use the dedicated sofinance database and role"); }
}
