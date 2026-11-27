/**
 * Railway `web` entry (railway/web.Dockerfile CMD): runs `next start` on 0.0.0.0:$PORT and, once it is healthy,
 * warms the store-backed ISR pages (`src/lib/isr-warmup.ts`). The server's exit code is the container's; signals are
 * passed on so Railway's SIGTERM drains it as before. A failed warm-up only logs: the pages then refresh on their
 * normal ISR window.
 */
import { spawn } from "node:child_process";
import { runIsrWarmup } from "../src/lib/isr-warmup.ts";

const port = process.env.PORT || "8080";
const log = (line: string) => process.stdout.write(`${line}\n`);

const server = spawn("node_modules/.bin/next", ["start", "--hostname", "0.0.0.0", "--port", port], { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.kill(signal));
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 + 15 : 1)));

runIsrWarmup({ baseUrl: `http://127.0.0.1:${port}`, secret: process.env.CRON_SECRET, log })
  .then((result) => log(`isr-warmup ${result}`))
  .catch(() => log("isr-warmup failed: unexpected error"));
