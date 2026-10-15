import "@/lib/engine-host";
import { createPermit } from "@sofinance/engine/auth/permit";

// Include the operation and every account/budget in the permit, so a recovery
// approval cannot be replayed as a compound approval or with another source.
const compoundPermit = createPermit("sofinance:compound:v1");

export const issueCompoundPermit = compoundPermit.issue;
export const verifyCompoundPermit = compoundPermit.verify;
