import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
vi.mock("server-only", () => ({}));
import { defineTool, dispatchTool, TOOL_DISPATCH, type McpDispatchContext } from "./dispatch";
import { listToolDefinitions, type ToolName } from "./tool-definitions";

it("covers every unique metadata name on both surfaces exactly once", () => {
  for (const surface of ["http", "stdio"] as const) {
    const names = listToolDefinitions(surface).map(tool => tool.name);
    expect(new Set(names).size).toBe(16);
    expect(names.toSorted()).toEqual(Object.keys(TOOL_DISPATCH).toSorted());
  }
});
it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "unknown"])("rejects non-own tool name %s", async name => {
  await expect(dispatchTool(name, {}, { surface: "mcp-stdio" })).rejects.toThrow(`Unknown tool: ${name}`);
});

describe("typed closure", () => {
  it("uses the parsed transform before binding, retains output type and never injects wallet", async () => {
    const events: string[] = [];
    const parser = z.object({ wallet: z.string().transform(value => { events.push("parse"); return value.trim(); }) });
    const run = defineTool({ parser, missingArgs: "raw",
      binding: { mode: "required-match", wallet: input => { events.push("binding"); return input.wallet; } },
      handler: input => { events.push("handler"); return { length: input.wallet.length }; },
    });
    expectTypeOf(run).returns.toEqualTypeOf<Promise<{ length: number }>>();
    expect(await run({ wallet: " w " }, { surface: "mcp-http", tokenWallet: "w" })).toEqual({ length: 1 });
    expect(events).toEqual(["parse", "binding", "handler"]);
    events.length = 0;
    await expect(run({ wallet: "other" }, { surface: "mcp-http", tokenWallet: "w" })).rejects.toThrow("Token wallet mismatch");
    expect(events).toEqual(["parse", "binding"]);
    events.length = 0;
    await expect(run({ wallet: 42 }, { surface: "mcp-http", tokenWallet: "w" })).rejects.toBeInstanceOf(z.ZodError);
    expect(events).toEqual([]);
    await run({ wallet: "other" }, { surface: "mcp-stdio" });
    expect(events).toEqual(["parse", "handler"]);
  });
  it("does not call a parser, wallet accessor or handler at definition time", () => {
    const parse = vi.fn(() => ({ wallet: "w" })), wallet = vi.fn(() => "w"), handler = vi.fn();
    defineTool({ parser: { parse }, missingArgs: "raw", binding: { mode: "required-match", wallet }, handler });
    expect(parse).not.toHaveBeenCalled(); expect(wallet).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });
});

// Checked by the native app tsc gate; deliberately never executed. Removing NoInfer or
// erasing schema inputs would make these @ts-expect-error directives fail compilation.
function typeConstraints() {
  const parser = z.object({ wallet: z.string(), amount: z.string() });
  defineTool({ parser, missingArgs: "raw", binding: { mode: "none" },
    // @ts-expect-error Handler input must match the parser, not independently infer number.
    handler: (input: { wallet: string; amount: number }) => input.amount,
  });
  defineTool({ parser, missingArgs: "raw", binding: {
    // @ts-expect-error Required-match needs a string wallet accessor, not an optional one.
    mode: "required-match", wallet: () => undefined,
  }, handler: input => input.amount });
  defineTool({ parser: z.object({ limit: z.number() }), missingArgs: "raw", binding: {
    mode: "required-match",
    // @ts-expect-error A schema without wallet cannot use a wallet-bearing accessor.
    wallet: (input: { wallet: string }) => input.wallet,
  }, handler: input => input.limit });
  // @ts-expect-error HTTP context cannot omit the authenticated token wallet.
  const unauthenticated: McpDispatchContext = { surface: "mcp-http" };
  // @ts-expect-error Every ToolName needs an execution closure.
  const incomplete: Record<ToolName, typeof TOOL_DISPATCH.list_positions> = { list_positions: TOOL_DISPATCH.list_positions };
  void unauthenticated; void incomplete;
}
void typeConstraints;
