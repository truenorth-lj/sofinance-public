/**
 * The shared DEX contract suite, written once and run against every implementation (DESIGN.md §1.6):
 *
 *   // src/lib/dex/<id>/<id>.contract.test.ts
 *   describeDexContract(meteoraModule, meteoraFixtures);
 *
 * Fixtures are hermetic: `setup` installs the DEX's recorded RPC / HTTP replays (captured from public endpoints, no keys
 * or RPC URLs), so the suite never touches the network and never sends a transaction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PositionKey } from "@/lib/unified-positions/model";
import type { DexAdapter, OpenRequest, StepContext } from "../adapter";
import { DexError, DexUnsupportedError } from "../errors";
import type { DexModule } from "../registry";
import {
  adapterContractProblems, descriptorContractProblems, forbiddenFetchProblems, positionContractProblems,
  quoteContractProblems, stepContractProblems,
} from "./checks";

export type DexContractFixtures = {
  /** Wallet whose recorded positions the fixtures replay. */
  owner: string;
  /** Installs recorded replays (vi.mock / fetch stubs); returns an optional teardown. */
  setup?: () => void | (() => void) | Promise<void | (() => void)>;
  /** Keys `listPositions(owner)` must return, in order. */
  expectedPositionKeys: readonly PositionKey[];
  /** An open the DEX can quote and prepare from the fixtures. */
  open?: { request: OpenRequest; expectedSteps: number; blocked?: boolean };
  /** A position to run withdraw / claim / compound / performance against. */
  positionKey?: PositionKey;
};

const FIRST_STEP: StepContext = Object.freeze({ step: 1, priorSignatures: [] });

async function expectUnsupported(call: () => Promise<unknown>) {
  await expect(call()).rejects.toBeInstanceOf(DexUnsupportedError);
}

export function describeDexContract(entry: DexModule, fixtures: DexContractFixtures): void {
  const { descriptor } = entry;
  describe(`DEX contract: ${descriptor.id}`, () => {
    let adapter: DexAdapter;
    let teardown: void | (() => void);
    const fetched: string[] = [];

    beforeEach(async () => {
      fetched.length = 0;
      teardown = await fixtures.setup?.();
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        fetched.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return realFetch(input, init);
      });
      if (!entry.adapter) throw new Error(`${descriptor.id} has no server adapter registered`);
      adapter = await entry.adapter();
    });
    afterEach(() => {
      vi.restoreAllMocks();
      if (typeof teardown === "function") teardown();
    });

    it("declares a consistent descriptor and wires it into its adapter", () => {
      expect(descriptorContractProblems(descriptor)).toEqual([]);
      expect(adapterContractProblems(descriptor, adapter)).toEqual([]);
      if (entry.poolSource) expect(entry.poolSource.id).toBe(descriptor.id);
    });

    it("lists the owner's positions in the unified shape, without GeckoTerminal", async () => {
      const positions = await adapter.listPositions(fixtures.owner);
      expect(positions.map((position) => position.key)).toEqual(fixtures.expectedPositionKeys);
      expect(positions.flatMap((position) => positionContractProblems(descriptor, position))).toEqual([]);
      expect(forbiddenFetchProblems(fetched)).toEqual([]);
    });

    it("throws DexUnsupportedError for every unsupported capability", async () => {
      const caps = descriptor.capabilities;
      const key = fixtures.positionKey ?? fixtures.expectedPositionKeys[0] ?? (`${descriptor.id}:fixture` as PositionKey);
      const request = fixtures.open?.request ?? { poolId: "fixture", owner: fixtures.owner, range: { kind: "preset", presetId: "standard" }, input: { token: "fixture", amountRaw: "1" }, slippageBps: 50 } satisfies OpenRequest;
      if (!caps.open.supported) await expectUnsupported(() => adapter.prepareOpen(request, FIRST_STEP));
      if (!caps.deposit.supported) await expectUnsupported(() => adapter.prepareAdd(key, request.input, FIRST_STEP));
      if (!caps.withdraw.supported) await expectUnsupported(() => adapter.prepareWithdraw(key, { fraction: 1, output: "pool-tokens" }, FIRST_STEP));
      if (caps.withdraw.supported && !caps.withdraw.partial) await expectUnsupported(() => adapter.prepareWithdraw(key, { fraction: 0.5, output: "pool-tokens" }, FIRST_STEP));
      if (!caps.claim.supported) await expectUnsupported(() => adapter.prepareClaim(key, FIRST_STEP));
      if (!caps.compound.supported) await expectUnsupported(() => adapter.prepareCompound(key, FIRST_STEP));
      if (!caps.performance.supported) await expectUnsupported(() => adapter.performance(key));
    });

    const open = fixtures.open;
    if (open && descriptor.capabilities.open.supported) {
      it("quotes an open within the declared steps, rent and range cap", async () => {
        const quote = await adapter.quoteOpen(open.request);
        expect(quoteContractProblems(descriptor, quote)).toEqual([]);
        expect(Boolean(quote.blockedReason)).toBe(Boolean(open.blocked));
        if (!open.blocked) expect(quote.steps).toBe(open.expectedSteps);
      });

      it(open.blocked ? "refuses the blocked open with a DexError" : "prepares the first open step for the owner", async () => {
        if (open.blocked) {
          await expect(adapter.prepareOpen(open.request, FIRST_STEP)).rejects.toBeInstanceOf(DexError);
          return;
        }
        const result = await adapter.prepareOpen(open.request, FIRST_STEP);
        expect(stepContractProblems(descriptor, result, fixtures.owner, descriptor.meta.openSteps)).toEqual([]);
        expect(result.of).toBe(open.expectedSteps);
      });
    }

    const positionKey = fixtures.positionKey;
    if (positionKey) {
      it("prepares a full withdraw for the owner", async () => {
        if (!descriptor.capabilities.withdraw.supported) return;
        const result = await adapter.prepareWithdraw(positionKey, { fraction: 1, output: "pool-tokens" }, FIRST_STEP);
        expect(stepContractProblems(descriptor, result, fixtures.owner)).toEqual([]);
      });

      it("reads performance without GeckoTerminal", async () => {
        if (!descriptor.capabilities.performance.supported) return;
        const performance = await adapter.performance(positionKey);
        expect(performance.key).toBe(positionKey);
        expect(forbiddenFetchProblems(fetched)).toEqual([]);
      });
    }
  });
}
