// Flakiness check: run the hermetic suite N times in fresh processes with retries disabled; exit non-zero on any failure.
// usage: node scripts/repeat.mjs [runs=5] [extra playwright args...]
import { spawnSync } from "node:child_process";
const runs = Number(process.argv[2] ?? 5);
const extra = process.argv.slice(3);
let green = 0;
for (let i = 1; i <= runs; i++) {
  const started = Date.now();
  const result = spawnSync("npx", ["playwright", "test", "--project=hermetic", "--retries=0", "--reporter=dot", ...extra], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const summary = (result.stdout.split("\n").filter((line) => /passed|failed|flaky/.test(line)).join(" | ")).trim();
  console.log(`run ${i}/${runs}: ${result.status === 0 ? "GREEN" : "RED"} (${((Date.now() - started) / 1000).toFixed(1)}s) ${summary}`);
  if (result.status === 0) green++; else console.log(result.stdout.slice(-3000));
}
console.log(`${green}/${runs} green`);
process.exit(green === runs ? 0 : 1);
