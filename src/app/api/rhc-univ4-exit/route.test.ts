import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/protocol-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/protocol-flags")>();
  return { ...actual, isRhcUniv4TxBuildEnabled: vi.fn(actual.isRhcUniv4TxBuildEnabled) };
});
vi.mock("@/lib/rhc-univ4-exit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rhc-univ4-exit")>();
  return { ...actual, runRhcUniv4Exit: vi.fn(async (input: { action: string }) => (input.action === "positions"
    ? { state: "positions", positions: [] }
    : { state: "failed", code: "not-owner", message: "Position #1 belongs to another wallet (0x2222…2222), not the connected one." })) };
});
import { runRhcUniv4Exit } from "@/lib/rhc-univ4-exit";
import { isRhcUniv4TxBuildEnabled } from "@/lib/protocol-flags";
import { GET, POST } from "./route";

const USER = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04";
const prepare = { action: "prepare", user: USER, tokenId: "4077059" };
const post = (body: unknown) => POST(new Request("https://example.test/api/rhc-univ4-exit", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("/api/rhc-univ4-exit", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("404s and never touches Robinhood Chain when the flag is off (kill switch)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.mocked(isRhcUniv4TxBuildEnabled).mockReturnValueOnce(false);
    const response = await post(prepare);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(runRhcUniv4Exit).not.toHaveBeenCalled();
  });

  it("GET is always 404", () => {
    expect(GET().status).toBe(404);
  });

  it("lists positions on preview with no-store (checksummed user, string ids)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const response = await post({ action: "positions", user: USER, tokenIds: ["4077059", "1"] });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ state: "positions", positions: [] });
    expect(runRhcUniv4Exit).toHaveBeenCalledWith({ action: "positions", user: getAddress(USER), tokenIds: ["4077059", "1"] });
  });

  it("returns a plain-language failure as 422", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const response = await post(prepare);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ state: "failed", code: "not-owner", message: expect.stringMatching(/belongs to another wallet/) });
  });

  it("rejects malformed input and unknown fields", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    for (const body of [
      "{not json", { ...prepare, action: "broadcast" }, { ...prepare, tokenId: "-1" }, { ...prepare, tokenId: 1 }, { ...prepare, user: "0x1234" },
      { ...prepare, recipient: USER }, { ...prepare, stateOverrides: {} }, { action: "positions", user: USER, tokenIds: [] },
      { action: "positions", user: USER, tokenIds: Array.from({ length: 11 }, (_, i) => String(i)) }, { action: "positions", user: USER, tokenIds: ["0x1"] },
    ]) expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    expect(runRhcUniv4Exit).not.toHaveBeenCalled();
  });

  it("route and lib never sign or send", () => {
    for (const file of ["src/app/api/rhc-univ4-exit/route.ts", "src/lib/rhc-univ4-exit.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/sendRawTransaction|sendTransaction|signTransaction|privateKey|walletClient|stateOverride/i);
    }
  });
});
