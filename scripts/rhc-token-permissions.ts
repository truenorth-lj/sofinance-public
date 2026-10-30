// Read-only recheck of the Robinhood Chain stock tokens' transfer controls (docs/rhc-token-permissions.md).
// Public RPC only (no env, no keys, nothing sent): `pnpm tsx scripts/rhc-token-permissions.ts`.
// Exit 1 when a beacon points at an implementation other than the reviewed one, or a token is paused right now.
import { createPublicClient, http, parseAbi, isAddressEqual, type Address } from "viem";
import { RHC_TOKEN_CONTROLS, UNIV4_RHC } from "@sofinance/engine/protocols/uniswap-v4/constants";

const PUBLIC_RPC = "https://robinhood-rpc.publicnode.com";
const client = createPublicClient({ transport: http(PUBLIC_RPC, { timeout: 15_000 }) });
const abi = parseAbi([
  "function implementation() view returns (address)",
  "function paused() view returns (bool)",
  "function tokenPauseManager() view returns (address)",
  "function isTokenPaused(address token) view returns (bool)",
  "function isBlocked(address account) view returns (bool)",
]);

async function read<T>(address: Address, functionName: "implementation" | "paused" | "tokenPauseManager" | "isTokenPaused" | "isBlocked", args: readonly Address[] = []): Promise<T | string> {
  try {
    return await client.readContract({ address, abi, functionName, args } as never) as T;
  } catch (error) {
    return `unreadable (${(error as { shortMessage?: string }).shortMessage ?? "error"})`;
  }
}

async function main() {
let problems = 0;
for (const controls of Object.values(RHC_TOKEN_CONTROLS)) {
  const line = (label: string, value: unknown) => process.stdout.write(`  ${label}: ${String(value)}\n`);
  process.stdout.write(`${controls.contract} ${controls.token}\n`);
  line("reviewed powers", controls.powers.join(", "));
  const implementation = await read<Address>(controls.beacon, "implementation");
  const reviewed = typeof implementation === "string" && implementation.startsWith("0x") && isAddressEqual(implementation as Address, controls.implementation);
  line("beacon implementation", `${implementation} (${reviewed ? "matches reviewed" : "DIFFERENT from reviewed " + controls.implementation})`);
  if (!reviewed) problems += 1;
  if (controls.pause.kind === "self") {
    for (const target of [controls.token, ...controls.pause.extraTargets]) {
      const paused = await read<boolean>(target, "paused");
      line(`paused() on ${target}`, paused);
      if (paused !== false) problems += 1;
    }
    line(`registry isBlocked(PoolManager)`, await read<boolean>(controls.pause.extraTargets[0] ?? controls.token, "isBlocked", [UNIV4_RHC.poolManager as Address]));
  } else {
    const manager = await read<Address>(controls.token, "tokenPauseManager");
    const sameManager = typeof manager === "string" && manager.startsWith("0x") && isAddressEqual(manager as Address, controls.pause.manager);
    line("tokenPauseManager()", `${manager} (${sameManager ? "matches reviewed" : "DIFFERENT from reviewed " + controls.pause.manager})`);
    if (!sameManager) problems += 1;
    const paused = await read<boolean>(controls.pause.manager, "isTokenPaused", [controls.token]);
    line("isTokenPaused(token)", paused);
    if (paused !== false) problems += 1;
  }
}
process.stdout.write(problems ? `${problems} check(s) need review.\n` : "All checks match the reviewed state.\n");
process.exitCode = problems ? 1 : 0;
}

void main();
