import { existsSync, readFileSync } from "node:fs";
import { describeBlockedEgress, readBlockedEgress, SERVER_EGRESS_LEDGER } from "../support/server-egress";

/**
 * Global teardown. When this run started its own hermetic server, that server must have loaded the egress guard, and
 * the whole run fails if the server tried to reach real Jupiter at any point (even between tests).
 */
export default function checkServerEgress() {
  if (process.env.BASE_URL || process.env.E2E_NO_SERVER) return;      // no server of ours: nothing to check
  const loaded = new URL(`${SERVER_EGRESS_LEDGER.href}.loaded`);
  if (!existsSync(loaded) || !readFileSync(loaded, "utf8").trim()) throw new Error("Hermetic server ran without the Jupiter egress guard (scripts/hermetic-egress-guard.mjs).");
  const blocked = describeBlockedEgress(readBlockedEgress());
  if (blocked.length) throw new Error(`Hermetic server tried to reach real Jupiter ${blocked.length} time(s):\n${blocked.join("\n")}`);
}
