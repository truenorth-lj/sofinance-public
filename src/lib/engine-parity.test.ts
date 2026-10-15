/**
 * Owner-mode parity: after switching to @sofinance/engine the open / compound / withdraw builders
 * must keep the same public surface and the same owner-mode (feePayer omitted) behaviour that the
 * in-tree modules had. Sponsored-mode (feePayer) is a new opt-in; sofinancelab never passes it.
 *
 * Golden fixtures for bytes live in the engine package (and were copied from this repo's
 * `src/lib/__snapshots__` at the cutover). This file guards the import surface and the default
 * owner-mode options so a future engine release that renames or reorders them fails here first.
 */
import { describe, expect, it } from "vitest";
import { assertCompoundTransactionSize, compileCompoundTransaction } from "@sofinance/engine/compound-atomic";
import { versionedTransactionSize, MAX_OPEN_TRANSACTION_BYTES } from "@sofinance/engine/open-transaction";
import { SOLANA_TX_SIZE_LIMIT } from "@sofinance/engine/transaction-limits";
import { configureEngine, engineEnv, isEngineConfigured } from "@sofinance/engine/host";
import { planFromSingleResult, packInstructionGroups } from "@sofinance/engine/plan";

describe("engine package surface (owner-mode parity)", () => {
  it("is configured by this app's engine-host (vitest setup + every entrypoint)", () => {
    expect(isEngineConfigured()).toBe(true);
    expect(engineEnv()).toBe(process.env);
  });
  it("keeps the 1,232-byte packet limit as the single source of truth", () => {
    expect(MAX_OPEN_TRANSACTION_BYTES).toBe(1_232);
    expect(SOLANA_TX_SIZE_LIMIT).toBe(1_232);
    expect(typeof assertCompoundTransactionSize).toBe("function");
    expect(typeof compileCompoundTransaction).toBe("function");
    expect(typeof versionedTransactionSize).toBe("function");
  });
  it("exposes the multi-transaction plan helpers without changing owner-mode builders", () => {
    expect(typeof planFromSingleResult).toBe("function");
    expect(typeof packInstructionGroups).toBe("function");
  });
  it("lets a host reconfigure without ambient process.env leakage", () => {
    const previous = engineEnv();
    configureEngine({ env: () => ({ JUPITER_API_KEY: "parity-only" }) });
    expect(engineEnv().JUPITER_API_KEY).toBe("parity-only");
    expect(process.env.JUPITER_API_KEY).not.toBe("parity-only");
    configureEngine({ env: () => previous });
  });
});
