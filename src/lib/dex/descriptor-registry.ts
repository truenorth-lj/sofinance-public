import { DEX_DESCRIPTORS } from "./descriptors";
import { createDexDescriptorRegistry } from "./registry";

/**
 * Client-and-server-safe descriptor registry: metadata and capabilities only. No tx adapter, wallet
 * hooks, or other React client stores, so public pool pages can read plan/open capability.
 */
export const dexDescriptors = createDexDescriptorRegistry(DEX_DESCRIPTORS);
