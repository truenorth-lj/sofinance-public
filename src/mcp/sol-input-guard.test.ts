// MCP open tools (and so /sign links) refuse native SOL while SOL_INPUT_ENABLED is false.
import { beforeEach, describe, expect, it, vi } from "vitest";
const backend = vi.hoisted(() => ({ openQuote: vi.fn(), openBuild: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/open-quote", () => ({ getOpenPositionQuoteBundle: backend.openQuote }));
vi.mock("@sofinance/engine/open-atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/open-atomic")>()),
  buildAndSimulateOpenPosition: backend.openBuild,
}));
import { prepareOpenPosition, quoteOpenPosition } from "./tools";
import { prepareOpenPositionSchema, quoteOpenPositionSchema } from "./schemas";
import { VALID_ARGS } from "./test-support/dispatch-fixtures";
import { SIGNING_SECRET } from "@/lib/test-support/send-fixtures";

const NOTE = "SOL deposits are temporarily unavailable — please use another token.";

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  backend.openQuote.mockReset();
  backend.openBuild.mockReset();
});

describe("MCP open tools with native SOL input", () => {
  it("quote_open_position rejects before quoting", async () => {
    await expect(quoteOpenPosition(quoteOpenPositionSchema.parse({ ...VALID_ARGS.quote_open_position, inputKind: "native" })))
      .rejects.toThrow(NOTE);
    expect(backend.openQuote).not.toHaveBeenCalled();
  });

  it("prepare_open_position rejects before building a transaction or sign link", async () => {
    await expect(prepareOpenPosition(prepareOpenPositionSchema.parse({ ...VALID_ARGS.prepare_open_position, inputKind: "native" })))
      .rejects.toThrow(NOTE);
    expect(backend.openBuild).not.toHaveBeenCalled();
  });
});
