import { describe, expect, it, vi } from "vitest";
import { BEAM_INLINE_LOOKUP_TIMEOUT_MS, beamAfterSend, noBeamAfterSend } from "@/lib/beam-after-send";
import { beamLandingUrl } from "@sofinance/engine/solami-beam";

const SIG = "5".repeat(88);

function hangingFetch() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
  }));
}

describe("beamAfterSend", () => {
  it("makes no lookup at all when no Beam tip was included", async () => {
    const fetcher = vi.fn();
    for (const plan of [null, undefined, { included: false }]) {
      await expect(beamAfterSend(SIG, plan, { fetcher: fetcher as unknown as typeof fetch })).resolves.toEqual({
        beam: null, label: null, beamLandingUrl: beamLandingUrl(SIG),
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("with a tip, makes exactly one attempt and never waits past the cap", async () => {
    const fetcher = hangingFetch();
    const started = Date.now();
    const result = await beamAfterSend(SIG, { included: true }, { fetcher: fetcher as unknown as typeof fetch, timeoutMs: 50 });
    const elapsed = Date.now() - started;
    expect(result).toEqual(noBeamAfterSend(SIG));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(elapsed).toBeLessThan(1_000);
  });

  it("with a tip, returns the landed label from a single quick lookup", async () => {
    const fetcher = vi.fn(async () => Response.json({ signature: SIG, is_landed: true, region: "fra", tip_lamports: 100000 }));
    const result = await beamAfterSend(SIG, { included: true }, { fetcher: fetcher as unknown as typeof fetch });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result.beam?.isLanded).toBe(true);
    expect(result.label).toContain("Landed via Beam");
    expect(result.beamLandingUrl).toBe(beamLandingUrl(SIG));
  });

  it("with a tip, a not-yet-landed or failing lookup is not retried", async () => {
    const notLanded = vi.fn(async () => Response.json({ signature: SIG, is_landed: false }));
    await expect(beamAfterSend(SIG, { included: true }, { fetcher: notLanded as unknown as typeof fetch })).resolves.toMatchObject({ label: null });
    expect(notLanded).toHaveBeenCalledOnce();
    const failing = vi.fn(async () => { throw new Error("beam down"); });
    await expect(beamAfterSend(SIG, { included: true }, { fetcher: failing as unknown as typeof fetch })).resolves.toEqual(noBeamAfterSend(SIG));
    expect(failing).toHaveBeenCalledOnce();
  });

  it("keeps the default inline cap short", () => {
    expect(BEAM_INLINE_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
  });
});
