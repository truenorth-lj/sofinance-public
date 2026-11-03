import { describe, expect, it } from "vitest";
import { publicDexMessage } from "./public-message";

describe("publicDexMessage", () => {
  it("drops stack frames, URLs and credentials, and keeps plain messages unchanged", () => {
    expect(publicDexMessage("That range is not available to open yet.")).toBe("That range is not available to open yet.");
    const out = publicDexMessage("RPC failed: wss://node.invalid/ws?api-key=sk_live_abcdef0123456789 at Connection.send (/var/task/x.js:1:2)\n    at run (/var/task/y.js:3:4)");
    expect(out).not.toMatch(/wss?:|https?:|api-key|sk_live|\/var\/task|\.js:\d/);
    expect(publicDexMessage("\n    at run (/x.js:1:1)")).toBe("The request could not be completed. Nothing was sent.");
  });
});
