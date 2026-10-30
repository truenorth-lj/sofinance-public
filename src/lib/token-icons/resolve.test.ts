import type { StoreRequest, StoreOperation, StoreResultMap, RwaStore } from "../rwa-store-types";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ICON_HOSTS, trustedIcon } from "@sofinance/engine/token-metadata";
import { MANUAL_TOKEN_ICONS, iconFor, tokenIconMap } from "./map";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { dexScreenerIcons, geckoTerminalIcons, raydiumIcons, resolveTokenIcons, type IconSources } from "./resolve";
import { storeRequestSchema } from "../rwa-store-types";

const SPCXX = "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8";
const OTHER = "So11111111111111111111111111111111111111112";
const RHC_SPCX = "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa";
const lease = { job: "rwa-discovery", owner: "00000000-0000-4000-8000-000000000000", epoch: 1 } as const;
const fixed = (map: Record<string, unknown>) => vi.fn(async () => map);

describe("token icon sources", () => {
  it("tries sources in order and stops asking once a token has an icon", async () => {
    const jupiter = fixed({ [SPCXX]: "https://xstocks-metadata.backed.fi/logos/tokens/SPCXx.png" });
    const raydium = fixed({ [OTHER]: `https://img-v1.raydium.io/icon/${OTHER}.png`, [SPCXX]: "https://img-v1.raydium.io/icon/x.png" });
    const rows = await resolveTokenIcons("solana", [SPCXX, OTHER, SPCXX],
      [{ source: "jupiter", lookup: jupiter }, { source: "raydium", lookup: raydium }], { manual: [] });
    expect(rows).toEqual([
      { chain: "solana", address: SPCXX, image: "https://xstocks-metadata.backed.fi/logos/tokens/SPCXx.png", source: "jupiter" },
      { chain: "solana", address: OTHER, image: `https://img-v1.raydium.io/icon/${OTHER}.png`, source: "raydium" },
    ]);
    expect(raydium).toHaveBeenCalledWith([OTHER], undefined);
  });

  it("drops off-allowlist links before anything is written and falls through to the next source, then manual", async () => {
    const sources: IconSources = [
      { source: "dexscreener", lookup: fixed({ [RHC_SPCX.toLowerCase()]: "https://evil.example/spcx.png" }) },
      { source: "geckoterminal", lookup: fixed({ [RHC_SPCX.toLowerCase()]: "http://coin-images.coingecko.com/x.png" }) },
    ];
    const rows = await resolveTokenIcons("robinhood", [RHC_SPCX], sources);
    expect(rows).toEqual([{ chain: "robinhood", address: RHC_SPCX.toLowerCase(), image: "https://s3-symbol-logo.tradingview.com/spacex.svg", source: "manual" }]);
    const none = await resolveTokenIcons("robinhood", [RHC_SPCX], sources, { manual: [] });
    expect(none).toEqual([]);
  });

  it("treats a failing source like an empty one", async () => {
    const onIssue = vi.fn();
    const rows = await resolveTokenIcons("robinhood", [RHC_SPCX], [
      { source: "dexscreener", lookup: vi.fn(async () => { throw new Error("503"); }) },
      { source: "geckoterminal", lookup: fixed({ [RHC_SPCX.toLowerCase()]: "https://coin-images.coingecko.com/coins/images/1/large/x.png" }) },
    ], { onIssue });
    expect(rows[0]).toMatchObject({ source: "geckoterminal" });
    expect(onIssue).toHaveBeenCalledWith("Token icons: dexscreener unavailable");
  });

  it("reads each indexer's field: Raydium logoURI, DexScreener base-token info.imageUrl, GeckoTerminal image_url", async () => {
    const json = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    expect(await raydiumIcons(json({ data: [{ address: SPCXX, logoURI: "https://img-v1.raydium.io/icon/a.png" }, null] }))([SPCXX]))
      .toEqual({ [SPCXX]: "https://img-v1.raydium.io/icon/a.png" });
    expect(await dexScreenerIcons(json([{ baseToken: { address: RHC_SPCX }, info: { imageUrl: "https://dd.dexscreener.com/a.png" } }, { baseToken: { address: RHC_SPCX } }]))([RHC_SPCX.toLowerCase()]))
      .toEqual({ [RHC_SPCX.toLowerCase()]: "https://dd.dexscreener.com/a.png" });
    const gecko = geckoTerminalIcons(json({ data: [{ attributes: { address: RHC_SPCX.toLowerCase(), image_url: "missing.png" } }] }));
    expect(await gecko([RHC_SPCX.toLowerCase()])).toEqual({});
  });

  it("covers every allowlisted Robinhood Chain token with one batched GeckoTerminal call (regression: per-token calls stopped at 10)", async () => {
    const tokens = [...new Set(UNIV4_RHC_ALLOWLISTED_POOLS.flatMap((pool) => [pool.currency0.address, pool.currency1.address]).map((a) => a.toLowerCase()))];
    expect(tokens).toHaveLength(22);
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url);
      const asked = url.split("/tokens/multi/")[1]!.split(",");
      return new Response(JSON.stringify({ data: asked.map((address, i) => ({ attributes: {
        address, image_url: `https://coin-images.coingecko.com/coins/images/${i}/large/t.png` } })) }), { status: 200 });
    }) as unknown as typeof fetch;
    const rows = await resolveTokenIcons("robinhood", tokens, [{ source: "geckoterminal", lookup: geckoTerminalIcons(fetcher) }], { manual: [] });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/networks/robinhood/tokens/multi/");
    expect(rows.map((row) => row.address).sort()).toEqual([...tokens].sort());
    expect(rows.every((row) => row.source === "geckoterminal" && row.image.startsWith("https://coin-images.coingecko.com/"))).toBe(true);
  });

  it("keeps every manual icon on ICON_HOSTS, including the Raydium / DexScreener / CoinGecko fallback hosts", () => {
    for (const row of MANUAL_TOKEN_ICONS) expect(trustedIcon(row.image), row.address).toBe(row.image);
    for (const host of ["img-v1.raydium.io", "dd.dexscreener.com", "coin-images.coingecko.com"]) expect(ICON_HOSTS.has(host)).toBe(true);
  });
});

describe("saveTokenIcons request", () => {
  const row = { chain: "solana", address: SPCXX, image: "https://xstocks-metadata.backed.fi/logos/tokens/SPCXx.png", source: "jupiter" } as const;
  it("accepts allowlisted links and rejects anything off ICON_HOSTS, non-https, or an uppercase EVM address", () => {
    expect(storeRequestSchema.safeParse({ op: "saveTokenIcons", lease, data: [row] }).success).toBe(true);
    for (const bad of [{ ...row, image: "https://evil.example/a.png" }, { ...row, image: "http://static.jup.ag/a.png" },
      { ...row, chain: "robinhood", address: RHC_SPCX }, { ...row, address: "not-a-mint" }])
      expect(storeRequestSchema.safeParse({ op: "saveTokenIcons", lease, data: [bad] }).success).toBe(false);
  });
});

describe("tokenIconMap / iconFor", () => {
  it("lets stored icons win over manual ones and falls back to manual for the rest (empty table → manual only)", () => {
    const map = tokenIconMap([{ chain: "solana", address: SPCXX, image: "https://static.jup.ag/spcxx.png", source: "jupiter" }]);
    expect(iconFor(map, "solana", SPCXX)).toBe("https://static.jup.ag/spcxx.png");
    expect(iconFor(tokenIconMap([]), "solana", SPCXX)).toBe("https://xstocks-metadata.backed.fi/logos/tokens/SPCXx.png");
    expect(iconFor(tokenIconMap([]), "robinhood", RHC_SPCX)).toBe("https://s3-symbol-logo.tradingview.com/spacex.svg");
  });
  it("returns null for an absent or malformed map", () => {
    expect(iconFor(undefined, "solana", SPCXX)).toBeNull();
    expect(iconFor({ solana: { [SPCXX]: "javascript:alert(1)" } }, "solana", SPCXX)).toBeNull();
    expect(iconFor({}, "robinhood", RHC_SPCX)).toBeNull();
  });
});

describe("missing rwa_token_icon table or column (migration 0002 not applied on prod yet)", () => {
  it("recognises undefined_table / undefined_column, also when drizzle wraps the driver error", async () => {
    const { isMissingRelation } = await import("../rwa-postgres-store");
    expect(isMissingRelation(Object.assign(new Error("relation \"rwa_token_icon\" does not exist"), { code: "42P01" }))).toBe(true);
    expect(isMissingRelation(new Error("Failed query", { cause: Object.assign(new Error("column"), { code: "42703" }) }))).toBe(true);
    expect(isMissingRelation(Object.assign(new Error("x"), { code: "23505" }))).toBe(false);
  });
  it("reads as no stored icons (no crash), so the map is the manual list and the cards fall back", async () => {
    const { tolerantTokenIcons } = await import("../rwa-postgres-store");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = await tolerantTokenIcons(async () => { throw new Error("Failed query", { cause: Object.assign(new Error("relation"), { code: "42P01" }) }); });
    expect(missing).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(await tolerantTokenIcons(async () => { throw new Error("connection reset"); })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(iconFor(tokenIconMap(missing), "robinhood", RHC_SPCX)).toBe("https://s3-symbol-logo.tradingview.com/spacex.svg");
    warn.mockRestore();
  });
  it("the daily job writes only allowlisted rows after renewing the lease, and surfaces a missing table as a rejected save", async () => {
    const { refreshTokenIcons } = await import("../rwa-refresh");
    const { RwaStoreError } = await import("../rwa-store-types");
    const calls: { op: string; data?: unknown }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("raydium")) return new Response(JSON.stringify({ data: [{ address: OTHER, logoURI: "https://evil.example/o.png" }] }));
      if (href.includes("dexscreener")) return new Response(JSON.stringify([]));
      if (href.includes("geckoterminal")) return new Response(JSON.stringify({ data: href.split("/tokens/multi/")[1]!.split(",").map((address) =>
        ({ attributes: { address, image_url: `https://coin-images.coingecko.com/coins/images/9/large/${address.slice(2, 8)}.png` } })) }));
      return new Response("[]");
    }) as unknown as typeof fetch;
    const behavior: { saveError?: Error } = {};
    function request<K extends StoreOperation>(input: StoreRequest<K>): Promise<StoreResultMap[K]>;
    async function request(input: StoreRequest): Promise<boolean | { saved: number }> {
      calls.push(input);
      if (input.op === "renew") return true;
      if (input.op === "saveTokenIcons") {
        if (behavior.saveError) throw behavior.saveError;
        return { saved: 1 };
      }
      throw new Error(`Unexpected icon-refresh operation: ${input.op}`);
    }
    const store: RwaStore = { request };
    await refreshTokenIcons(store, lease, [{ mintA: SPCXX, mintB: OTHER }], fetcher, new AbortController().signal);
    expect(calls.map((c) => c.op)).toEqual(["renew", "saveTokenIcons"]);
    const saved = calls[1]!.data as { address: string; image: string; source: string }[];
    expect(saved.every((row) => trustedIcon(row.image) === row.image)).toBe(true);
    expect(saved.find((row) => row.address === OTHER)).toBeUndefined();
    expect(saved.find((row) => row.address === SPCXX)?.source).toBe("manual");
    // All 22 allowlisted Robinhood Chain tokens get an indexer icon (not only SPCX via the manual list).
    expect(saved.filter((row) => row.source === "geckoterminal").map((row) => row.address)).toHaveLength(22);
    behavior.saveError = new RwaStoreError("TOKEN_ICONS_UNAVAILABLE");
    await expect(refreshTokenIcons(store, lease, [], fetcher, new AbortController().signal)).rejects.toMatchObject({ code: "TOKEN_ICONS_UNAVAILABLE" });
  });
});
