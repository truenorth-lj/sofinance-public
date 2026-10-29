import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rhc-univ4-open", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rhc-univ4-open")>();
  return { ...actual, runRhcUniv4Open: vi.fn(async () => ({ state: "needs_signature", plan: { feeRecipientIsPlaceholder: true } })) };
});
import { runRhcUniv4Open } from "@/lib/rhc-univ4-open";
import { GET, POST } from "./route";

const POOL = "0x4f54c74021e4139bbc4c7bc924346c921975136ea120cf118a93c43b50bdbd3c";
const SPCX = "0x4a0E65A3ecceC6dBE60aE065F2e7bB85faE35eEa";
const USER = "0xab9069703d7df7c4a472bc634312f087f0b9b320";
const prepare = { action: "prepare", poolId: POOL, user: USER, depositToken: SPCX, amount: "2000000000000000000", tickLower: -11, tickUpper: 9 };
const post = (body: unknown) => POST(new Request("https://example.test/api/rhc-univ4-open", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("/api/rhc-univ4-open", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it.each([undefined, "production"])("404s and never touches Robinhood Chain when VERCEL_ENV=%s (flag off)", async (env) => {
    vi.stubEnv("VERCEL_ENV", env);
    const response = await post(prepare);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(runRhcUniv4Open).not.toHaveBeenCalled();
  });

  it("GET is always 404", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(GET().status).toBe(404);
  });

  it("builds on preview with no-store", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const response = await post(prepare);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ state: "needs_signature", plan: { feeRecipientIsPlaceholder: true } });
    expect(runRhcUniv4Open).toHaveBeenCalledWith(expect.objectContaining({ action: "prepare", amount: "2000000000000000000", tickLower: -11 }));
  });

  it("rejects malformed input and never forwards state overrides or unknown fields", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    for (const body of [
      "{not json", { ...prepare, action: "broadcast" }, { ...prepare, amount: "-1" }, { ...prepare, amount: 1 }, { ...prepare, user: "0x1234" },
      { ...prepare, tickLower: 1.5 }, { ...prepare, stateOverrides: { [USER]: { balance: "0x1" } } },
      { ...prepare, action: "finalize", attempt: 0, signature: "0x12", permit: {} },
    ]) expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    expect(runRhcUniv4Open).not.toHaveBeenCalled();
  });

  it("route and lib never sign or send", () => {
    for (const file of ["src/app/api/rhc-univ4-open/route.ts", "src/lib/rhc-univ4-open.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/sendRawTransaction|sendTransaction|signTransaction|privateKey|walletClient|stateOverride/i);
    }
  });
});
