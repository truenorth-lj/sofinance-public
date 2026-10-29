import "@/lib/engine-host";
import { createPermit } from "@sofinance/engine/auth/permit";

// Step 1/2 of a two-transaction SOL open. Its own namespace, so a swap-step
// approval can never be replayed as an open-position (or any other) approval.
const solSwapPermit = createPermit("sofinance:sol-swap-step:v1");

export const issueSolSwapPermit = solSwapPermit.issue;
export const verifySolSwapPermit = solSwapPermit.verify;
