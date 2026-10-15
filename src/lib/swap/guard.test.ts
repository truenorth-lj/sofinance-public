import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
const root = join(import.meta.dirname, "../..");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [join(directory, entry.name)] : []);
}
it("keeps every swap API request in the one shared client and forbids direct SDK swaps", () => {
  const violations: string[] = [];
  for (const file of files(root)) {
    const path = relative(root, file), source = readFileSync(file, "utf8");
    // Sole exception: the compound yield swap. A Jupiter `route` leg (own program
    // id + ~29 accounts) cannot fit harvest + swap + add in one 1,232-byte packet;
    // the native own-pool swap_v2 reuses the harvest/add keys (see compound-size.test.ts).
    if (/makeSwapBaseInInstructions|PoolUtils\.computeAmountOut|swapInternal\(/.test(source) && path !== "lib/swap/compound.ts") violations.push(path);
    if (/path:\s*["']\/swap\//.test(source) && path !== "lib/swap/client.ts") violations.push(path);
    if (/jupiterSwapInstructions\s*[<(]/.test(source) && !["lib/swap/client.ts", "lib/swap/jupiter.ts", "lib/swap/exit.ts"].includes(path)) violations.push(path);
  }
  expect(violations).toEqual([]);
});
