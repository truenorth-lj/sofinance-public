import "@/lib/engine-host";
import { createPermit } from "@sofinance/engine/auth/permit";

// In-app spot swap (USDC -> stock token). Its own namespace, so a spot-swap approval can never be replayed as an
// open-position, SOL-swap or any other approval. The relay path (`/api/tx-send`) still requires the prepare-issued
// send permit and the strict byte match like every other flow.
const spotSwapPermit = createPermit("sofinance:spot-swap:v1");

export const issueSpotSwapPermit = spotSwapPermit.issue;
export const verifySpotSwapPermit = spotSwapPermit.verify;
