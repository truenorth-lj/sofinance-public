import "@/lib/engine-host";
import { createPermit } from "@sofinance/engine/auth/permit";

// Canonical JSON of { wallet, message, summary } so a recovery/add/compound
// approval cannot be replayed as an open-position approval.
const openPositionPermit = createPermit("sofinance:open-position:v1");

export const issueOpenPositionPermit = openPositionPermit.issue;
export const verifyOpenPositionPermit = openPositionPermit.verify;
