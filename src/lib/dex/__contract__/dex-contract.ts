/**
 * The shared DEX contract suite, written once and run against every implementation (DESIGN.md §1.6):
 *
 *   // src/lib/dex/<id>/<id>.contract.test.ts
 *   describeDexContract(meteoraModule, meteoraFixtures);
 *
 * Every registered DEX must have that file (registry.test.ts enforces it). Fixtures are hermetic: `setup` installs the
 * DEX's recorded RPC replays and `fetch` answers recorded HTTP calls (captured from public endpoints, no keys or RPC
 * URLs). Any fetch the fixtures do not answer fails the test, so the suite never touches the network and never sends a
 * transaction. The block sits in the vitest setup file `src/lib/test-support/offline-fetch.ts`, installed before any
 * module loads, so it also covers libraries that captured `fetch` at load time (@solana/web3.js `Connection`).
 *
 * A capability marked supported must come with the fixture that exercises it (open → `open`; add / withdraw / claim /
 * compound / performance → `positionKey`), otherwise the suite fails: nothing supported is silently skipped.
 */
import type { AddressLookupTableAccount } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setFetchReplay } from "@/lib/test-support/offline-fetch";
import type { PositionKey } from "@/lib/unified-positions/model";
import type { DexAdapter, DexDepositInput, OpenRequest, StepContext, StepResult } from "../adapter";
import { DexError, DexUnsupportedError } from "../errors";
import type { DexModule } from "../registry";
import {
  adapterContractProblems, descriptorContractProblems, forbiddenFetchProblems, positionContractProblems,
  feePolicyCharges, quoteContractProblems, stepContractProblems, thrownErrorProblems, type StepCheckOptions,
} from "./checks";

export type DexContractFixtures = {
  /** Wallet whose recorded positions the fixtures replay. */
  owner: string;
  /** Installs recorded replays (vi.mock / RPC stubs); returns an optional teardown. */
  setup?: () => void | (() => void) | Promise<void | (() => void)>;
  /**
   * Recorded HTTP replays. Return a Response for a recorded request, or undefined: an unanswered request fails the
   * test (it is never passed to the real network).
   */
  fetch?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  /** Keys `listPositions(owner)` must return, in order. */
  expectedPositionKeys: readonly PositionKey[];
  /**
   * An open the DEX can quote and prepare from the fixtures (required when `capabilities.open` is supported).
   * `expectedFeeBaseRaw`: the amount the open fee rule applies to (e.g. the swapped part of the input); the quoted
   * platform fee must equal `adapter.fees.feeFor("open", base)`. Required whenever the open fee rule is not "none".
   */
  open?: { request: OpenRequest; expectedSteps: number; expectedFeeBaseRaw?: string };
  /** Opens the DEX must refuse with a plain-English `blockedReason` and a DexError (e.g. wider than one position). */
  blockedOpens?: readonly OpenRequest[];
  /** A position to run add / withdraw / claim / compound / performance against. */
  positionKey?: PositionKey;
  /**
   * A wallet that does not own `positionKey` (required when any position op is supported). Every supported position op
   * called with it must reject with POSITION_NOT_FOUND before building anything.
   */
  stranger?: string;
  /** Deposit used for `prepareAdd`; defaults to `open.request.input`. */
  addInput?: DexDepositInput;
  /**
   * Instruction-level facts for the step checks. `feeWallet` is required whenever the fee policy charges anything;
   * `mintPrograms` is required for every Solana DEX (see `missingFixtureProblems`).
   */
  feeWallet?: string;
  addressLookupTables?: readonly AddressLookupTableAccount[];
  mintPrograms?: StepCheckOptions["mintPrograms"];
  systemTransferRecipients?: readonly string[];
  evmAllowedTargets?: readonly string[];
  evmApproveSpender?: string;
};

const FIRST_STEP: StepContext = Object.freeze({ step: 1, priorSignatures: [] });
/** Safety bound on how many steps the suite walks for one operation. */
const MAX_WALKED_STEPS = 16;

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return "(invalid url)"; }
}

/** What each supported capability needs from the fixtures; non-empty = the suite fails. */
export function missingFixtureProblems(entry: DexModule, fixtures: DexContractFixtures): string[] {
  const caps = entry.descriptor.capabilities;
  const problems: string[] = [];
  if (!entry.adapter) problems.push("no server adapter registered");
  if (caps.open.supported && !fixtures.open) problems.push("open is supported but fixtures.open is missing");
  const keyed = (["deposit", "withdraw", "claim", "compound", "performance"] as const).filter((cap) => caps[cap].supported);
  if (keyed.length && !fixtures.positionKey) problems.push(`${keyed.join(", ")} supported but fixtures.positionKey is missing`);
  const ops = (["deposit", "withdraw", "claim", "compound"] as const).filter((cap) => caps[cap].supported);
  if (ops.length && !fixtures.stranger) problems.push(`${ops.join(", ")} supported but fixtures.stranger (a non-owner wallet) is missing`);
  if (caps.deposit.supported && !fixtures.addInput && !fixtures.open) problems.push("deposit is supported but fixtures.addInput (or fixtures.open) is missing");
  const { feePolicy } = entry.descriptor.meta;
  if (feePolicyCharges(feePolicy) && !fixtures.feeWallet) problems.push("the fee policy charges a fee but fixtures.feeWallet is missing");
  if (caps.open.supported && feePolicy.open.kind !== "none" && fixtures.open && fixtures.open.expectedFeeBaseRaw === undefined) {
    problems.push(`the open fee rule is ${feePolicy.open.kind} but fixtures.open.expectedFeeBaseRaw is missing`);
  }
  if (entry.descriptor.chain === "solana" && !fixtures.mintPrograms) problems.push("Solana DEX without fixtures.mintPrograms (token program of every mint the steps touch)");
  return problems;
}

export function describeDexContract(entry: DexModule, fixtures: DexContractFixtures): void {
  const { descriptor } = entry;
  const caps = descriptor.capabilities;
  const stepOptions: StepCheckOptions = {
    feeWallet: fixtures.feeWallet,
    addressLookupTables: fixtures.addressLookupTables,
    mintPrograms: fixtures.mintPrograms,
    systemTransferRecipients: fixtures.systemTransferRecipients,
    evmAllowedTargets: fixtures.evmAllowedTargets,
    evmApproveSpender: fixtures.evmApproveSpender,
  };

  describe(`DEX contract: ${descriptor.id}`, () => {
    let adapter: DexAdapter;
    let teardown: void | (() => void);
    let restoreFetch: (() => void) | undefined;
    const fetched: string[] = [];
    const unanswered: string[] = [];

    /** Runs an adapter call; anything it throws must be a DexError. */
    async function call<T>(run: () => Promise<T>): Promise<T> {
      try {
        return await run();
      } catch (error) {
        expect(thrownErrorProblems(error)).toEqual([]);
        throw error;
      }
    }

    /** Prepares every step of an operation (step N gets the fake signatures of 1..N-1) and checks each one. */
    async function walkSteps(prepare: (context: StepContext) => Promise<StepResult>, expectedSteps?: { min: number; max: number }) {
      const results: StepResult[] = [];
      let context: StepContext = FIRST_STEP;
      for (let i = 0; i < MAX_WALKED_STEPS; i += 1) {
        const result = await call(() => prepare(context));
        expect(result.step).toBe(context.step);
        expect(stepContractProblems(descriptor, result, fixtures.owner, { ...stepOptions, expectedSteps })).toEqual([]);
        results.push(result);
        if (result.done) return results;
        context = { step: context.step + 1, priorSignatures: [...context.priorSignatures, `fixture-signature-${context.step}`], planToken: result.planToken };
      }
      throw new Error(`${descriptor.id}: no step reported done within ${MAX_WALKED_STEPS} steps`);
    }

    beforeEach(async () => {
      fetched.length = 0;
      unanswered.length = 0;
      teardown = await fixtures.setup?.();
      // Routes every fetch that reaches the offline guard, including copies captured at load time, to the fixtures.
      restoreFetch = setFetchReplay(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        fetched.push(url);
        const replay = await fixtures.fetch?.(url, init);
        if (replay) return replay;
        unanswered.push(hostOf(url));
        throw new Error(`Unmocked fetch to ${hostOf(url)}: the DEX contract suite is offline; record a fixture replay`);
      });
      if (!entry.adapter) throw new Error(`${descriptor.id} has no server adapter registered`);
      adapter = await entry.adapter();
    });
    afterEach(() => {
      restoreFetch?.();
      restoreFetch = undefined;
      if (typeof teardown === "function") teardown();
      // Fails the test even if the adapter swallowed the rejection.
      expect(unanswered, "fetches not answered by fixtures (the suite must be offline)").toEqual([]);
    });

    it("has a fixture for every supported capability", () => {
      expect(missingFixtureProblems(entry, fixtures)).toEqual([]);
    });

    it("declares a consistent descriptor and wires it into its adapter", () => {
      expect(descriptorContractProblems(descriptor)).toEqual([]);
      expect(adapterContractProblems(descriptor, adapter)).toEqual([]);
      if (entry.poolSource) expect(entry.poolSource.id).toBe(descriptor.id);
    });

    it("lists the owner's positions in the unified shape, without GeckoTerminal", async () => {
      const positions = await call(() => adapter.listPositions(fixtures.owner));
      expect(positions.map((position) => position.key)).toEqual(fixtures.expectedPositionKeys);
      expect(positions.flatMap((position) => positionContractProblems(descriptor, position))).toEqual([]);
      expect(forbiddenFetchProblems(fetched)).toEqual([]);
    });

    it("throws DexUnsupportedError for every unsupported capability", async () => {
      const key = fixtures.positionKey ?? fixtures.expectedPositionKeys[0] ?? (`${descriptor.id}:fixture` as PositionKey);
      const request = fixtures.open?.request ?? { poolId: "fixture", owner: fixtures.owner, range: { kind: "preset", presetId: "standard" }, input: { token: "fixture", amountRaw: "1" }, slippageBps: 50 } satisfies OpenRequest;
      const unsupported = async (run: () => Promise<unknown>) => expect(run()).rejects.toBeInstanceOf(DexUnsupportedError);
      if (!caps.open.supported) await unsupported(() => adapter.prepareOpen(request, FIRST_STEP));
      const owner = fixtures.owner;
      if (!caps.deposit.supported) await unsupported(() => adapter.prepareAdd(key, owner, request.input, FIRST_STEP));
      if (!caps.withdraw.supported) await unsupported(() => adapter.prepareWithdraw(key, owner, { fraction: 1, output: "pool-tokens" }, FIRST_STEP));
      if (caps.withdraw.supported && !caps.withdraw.partial) await unsupported(() => adapter.prepareWithdraw(key, owner, { fraction: 0.5, output: "pool-tokens" }, FIRST_STEP));
      if (!caps.claim.supported) await unsupported(() => adapter.prepareClaim(key, owner, FIRST_STEP));
      if (!caps.compound.supported) await unsupported(() => adapter.prepareCompound(key, owner, FIRST_STEP));
      if (!caps.performance.supported) await unsupported(() => adapter.performance(key));
    });

    const open = fixtures.open;
    if (open && caps.open.supported) {
      it("quotes an open deterministically, within the declared steps, rent, range cap and fee policy", async () => {
        const quote = await call(() => adapter.quoteOpen(open.request));
        expect(quoteContractProblems(descriptor, quote)).toEqual([]);
        expect(quote.blockedReason).toBeUndefined();
        expect(quote.steps).toBe(open.expectedSteps);
        expect(await call(() => adapter.quoteOpen(open.request))).toEqual(quote);
        if (open.expectedFeeBaseRaw !== undefined) expect(quote.platformFeeRaw).toBe(adapter.fees.feeFor("open", BigInt(open.expectedFeeBaseRaw)).toString());
        else expect(descriptor.meta.feePolicy.open.kind, "open charges a fee: set fixtures.open.expectedFeeBaseRaw").toBe("none");
      });

      it("prepares every open step for the owner", async () => {
        const steps = await walkSteps((context) => adapter.prepareOpen(open.request, context), descriptor.meta.openSteps);
        expect(steps).toHaveLength(open.expectedSteps);
      });
    }

    for (const [index, request] of (fixtures.blockedOpens ?? []).entries()) {
      it(`refuses blocked open #${index + 1} with a plain-English reason and a DexError`, async () => {
        if (!caps.open.supported) {
          await expect(adapter.prepareOpen(request, FIRST_STEP)).rejects.toBeInstanceOf(DexUnsupportedError);
          return;
        }
        const quote = await call(() => adapter.quoteOpen(request));
        expect(quoteContractProblems(descriptor, quote)).toEqual([]);
        expect(quote.blockedReason?.trim()).toBeTruthy();
        await expect(adapter.prepareOpen(request, FIRST_STEP)).rejects.toBeInstanceOf(DexError);
      });
    }

    const positionKey = fixtures.positionKey;
    if (positionKey) {
      if (caps.withdraw.supported) {
        it("prepares a full withdraw for the owner", async () => {
          await walkSteps((context) => adapter.prepareWithdraw(positionKey, fixtures.owner, { fraction: 1, output: "pool-tokens" }, context));
        });
        if (caps.withdraw.partial) {
          it("prepares a partial withdraw for the owner", async () => {
            await walkSteps((context) => adapter.prepareWithdraw(positionKey, fixtures.owner, { fraction: 0.5, output: "pool-tokens" }, context));
          });
        }
      }

      const addInput = fixtures.addInput ?? open?.request.input;
      if (caps.deposit.supported && addInput) {
        it("prepares an add for the owner", async () => {
          await walkSteps((context) => adapter.prepareAdd(positionKey, fixtures.owner, addInput, context));
        });
      }

      if (caps.claim.supported) {
        it("prepares a claim for the owner", async () => {
          await walkSteps((context) => adapter.prepareClaim(positionKey, fixtures.owner, context));
        });
      }

      const stranger = fixtures.stranger;
      if (stranger) {
        it("refuses every supported position op for a wallet that does not own the position", async () => {
          const refused = async (run: () => Promise<unknown>) => {
            const error = await run().then(() => null, (thrown: unknown) => thrown);
            expect(error, "a non-owner got a prepared step").toBeInstanceOf(DexError);
            expect((error as DexError).code).toBe("POSITION_NOT_FOUND");
          };
          if (caps.withdraw.supported) await refused(() => adapter.prepareWithdraw(positionKey, stranger, { fraction: 1, output: "pool-tokens" }, FIRST_STEP));
          if (caps.deposit.supported && addInput) await refused(() => adapter.prepareAdd(positionKey, stranger, addInput, FIRST_STEP));
          if (caps.claim.supported) await refused(() => adapter.prepareClaim(positionKey, stranger, FIRST_STEP));
          if (caps.compound.supported) await refused(() => adapter.prepareCompound(positionKey, stranger, FIRST_STEP));
        });
      }

      if (caps.compound.supported) {
        it("prepares a compound for the owner", async () => {
          await walkSteps((context) => adapter.prepareCompound(positionKey, fixtures.owner, context));
        });
      }

      if (caps.performance.supported) {
        it("reads performance without GeckoTerminal", async () => {
          const performance = await call(() => adapter.performance(positionKey));
          expect(performance.key).toBe(positionKey);
          expect(forbiddenFetchProblems(fetched)).toEqual([]);
        });
      }
    }
  });
}
