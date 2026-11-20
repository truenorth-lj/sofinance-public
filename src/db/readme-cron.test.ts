import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("documents the vercel.json refresh cron in db/README.md", () => {
  const vercel = JSON.parse(readFileSync(resolve("vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
  const schedule = vercel.crons.find((entry) => entry.path === "/api/internal/rwa-refresh")?.schedule;
  const documented = /GET `\/api\/internal\/rwa-refresh` at `([^`]+)`/.exec(readFileSync(resolve("db/README.md"), "utf8"));
  expect(schedule).toBeTruthy();
  expect(documented?.[1]).toBe(schedule);
});
