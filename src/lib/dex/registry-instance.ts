import "server-only";
import { DEX_MODULES } from "./modules";
import { createDexRegistry } from "./registry";

/** One server registry shared by public entrypoints and internal services, without a barrel cycle. */
export const dexRegistry = createDexRegistry(DEX_MODULES);
