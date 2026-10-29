import "server-only";

import { DEFAULT_PROTOCOL, type ProtocolId } from "@sofinance/engine/protocols/types";
import { buildSelectedAddInstruction } from "./selected-add-instruction";

/**
 * App-side protocol builders that live outside the engine (the add-liquidity
 * instruction is built in the app from the selected-position quote). Like the
 * engine adapter, entries are the existing functions by reference.
 */
export type AppProtocolBuilders = Readonly<{
  buildAddInstruction: typeof buildSelectedAddInstruction;
}>;

const APP_BUILDERS: Readonly<Record<ProtocolId, AppProtocolBuilders>> = Object.freeze({
  "raydium-clmm": Object.freeze({ buildAddInstruction: buildSelectedAddInstruction }),
});

export function getAppProtocolBuilders(protocol: ProtocolId = DEFAULT_PROTOCOL): AppProtocolBuilders {
  return APP_BUILDERS[protocol];
}
