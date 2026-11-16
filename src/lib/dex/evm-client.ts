/** Optional browser registry for native EVM flows; metadata-only consumers stay on ./client. */
import { uniswapV4RhcClientModule } from "./uniswap-v4-rhc/client-module";
import type { NativeEvmClientModule } from "./evm-client-module";
import { normalizeDexId } from "./types";
import { DexUnsupportedError } from "./errors";

const modules: readonly NativeEvmClientModule[] = [uniswapV4RhcClientModule];
const byId = new Map(modules.map(entry => [entry.id, entry]));

export function evmClientFor(id: string): NativeEvmClientModule {
  const canonical = normalizeDexId(id);
  const binding = canonical ? byId.get(canonical) : undefined;
  if (!binding) throw new DexUnsupportedError();
  return binding;
}
export type * from "@/lib/evm-client-types";
