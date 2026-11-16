import type { PoolProtocolId } from "@sofinance/engine/protocols/types";
import { poolSourceFor as registeredSourceFor } from "@/lib/dex";
import type { PoolSource } from "./types";

export { scanPoolSources } from "@/lib/dex";

/** Legacy rows with no registered protocol keep the cron's original Raydium fallback. */
export async function poolSourceFor(protocol: PoolProtocolId | undefined): Promise<PoolSource> {
  const source = protocol ? await registeredSourceFor(protocol) : null;
  const fallback = source ?? await registeredSourceFor("raydium-clmm");
  if (!fallback) throw new Error("Default pool source is not registered");
  return fallback;
}
