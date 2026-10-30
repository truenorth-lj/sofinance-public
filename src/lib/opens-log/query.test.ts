import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { queryOpensDaily } from "./query";

describe("opens query without runtime DDL", () => {
  it("performs only the two report reads", async () => {
    const sql = { unsafe: vi.fn<(query: string) => Promise<[]>>(async () => []) };
    const result = await queryOpensDaily({ sql });
    expect(result.configured).toBe(true);
    expect(sql.unsafe).toHaveBeenCalledTimes(2);
    for (const [query] of sql.unsafe.mock.calls) expect(query.trim()).toMatch(/^SELECT /);
  });
  it("propagates a missing schema without attempting to create it", async () => {
    const sql = { unsafe: vi.fn(async () => { throw new Error("missing table"); }) };
    await expect(queryOpensDaily({ sql })).rejects.toThrow("missing table");
    expect(sql.unsafe).toHaveBeenCalledTimes(1);
  });
});
