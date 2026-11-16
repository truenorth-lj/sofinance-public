import { afterEach, expect, it, vi } from "vitest";
import { evmLiquiditySchemasFor, runEvmOpen, runEvmExit } from "./index";
import { isRhcUniv4TxBuildEnabled } from "@/lib/protocol-flags";
import { POST as openPost } from "@/app/api/rhc-univ4-open/route";
import { POST as exitPost } from "@/app/api/rhc-univ4-exit/route";

vi.mock("server-only", () => ({}));
const loaded = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/dex/uniswap-v4-rhc/open.server", () => {
  loaded.push("open");
  return { runRhcUniv4Open: vi.fn(async () => ({ state: "failed", code: "guard", message: "test" })) };
});
vi.mock("@/lib/dex/uniswap-v4-rhc/exit.server", () => {
  loaded.push("exit");
  return { runRhcUniv4Exit: vi.fn(async () => ({ state: "positions", positions: [] })) };
});
vi.mock("@/lib/protocol-flags", async original => {
  const actual = await original<typeof import("@/lib/protocol-flags")>();
  return { ...actual, isRhcUniv4TxBuildEnabled: vi.fn(actual.isRhcUniv4TxBuildEnabled) };
});
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(isRhcUniv4TxBuildEnabled).mockReset(); });
const prepare = { action: "prepare", poolId: `0x${"11".repeat(32)}`, user: "0x0000000000000000000000000000000000000001",
  depositToken: "0x0000000000000000000000000000000000000002", amount: "1", tickLower: -11, tickUpper: 9 };
const request = () => new Request("https://example.test/api/native", { method: "POST", body: "{}" });

it("loads no builder for metadata, invalid input, or disabled native requests in any deploy target", async () => {
  const schemas = evmLiquiditySchemasFor("uniswap-v4-rhc");
  expect(loaded).toEqual([]);
  expect(schemas.open.safeParse({}).success).toBe(false);
  vi.mocked(isRhcUniv4TxBuildEnabled).mockReturnValue(true);
  expect((await openPost(request())).status).toBe(400);
  expect((await exitPost(request())).status).toBe(400);
  const open = schemas.open.parse(prepare), exit = schemas.exit.parse({ action: "positions", user: prepare.user, tokenIds: ["1"] });
  for (const target of ["production", "preview", "development"]) {
    vi.stubEnv("VERCEL_ENV", target); vi.mocked(isRhcUniv4TxBuildEnabled).mockReturnValue(false);
    expect((await openPost(request())).status).toBe(404);
    expect((await exitPost(request())).status).toBe(404);
    await expect(runEvmOpen("uniswap-v4-rhc", open)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(runEvmExit("uniswap-v4-rhc", exit)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  }
  expect(loaded).toEqual([]);
  vi.mocked(isRhcUniv4TxBuildEnabled).mockReturnValue(true);
  await runEvmOpen("uniswap-v4-rhc", open);
  expect(loaded).toEqual(["open"]);
  await runEvmExit("uniswap-v4-rhc", exit);
  expect(loaded).toEqual(["open", "exit"]);
});
