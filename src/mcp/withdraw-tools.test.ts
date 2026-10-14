import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { WITHDRAW_TOOL_DEFINITIONS } from "./withdraw-tools";
it("registers shared prepare and submit withdrawal tools on both transports", () => {
    expect(WITHDRAW_TOOL_DEFINITIONS.map(t => t.name)).toEqual(["prepare_withdraw", "submit_withdraw"]);
    for (const path of [new URL("./server.ts", import.meta.url), new URL("../app/api/mcp/route.ts", import.meta.url)]) {
        const code = readFileSync(path, "utf8");
        expect(code).toContain("...WITHDRAW_TOOL_DEFINITIONS");
        expect(code).toContain('case "prepare_withdraw"');
        expect(code).toContain('case "submit_withdraw"');
    }
});
