import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dynamic, GET } from "./route";

describe("/server.json", () => {
  it("serves the repo-root registry entry byte-for-byte as JSON, statically", async () => {
    expect(dynamic).toBe("force-static");
    const response = GET();
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const onDisk = JSON.parse(readFileSync(join(process.cwd(), "server.json"), "utf8"));
    expect(await response.json()).toEqual(onDisk);
    expect(onDisk.description.length).toBeLessThanOrEqual(100);
    expect(onDisk.description).toMatch(/Raydium and Meteora/);
  });
});
