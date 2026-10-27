import "@/lib/engine-host";
import "server-only";
import { buildAndSimulateOpenPosition } from "@sofinance/engine/open-atomic";
import type { OpenPositionSelection } from "@sofinance/engine/open-state";
import type { OpenRangeInput } from "@sofinance/engine/open-range";
import { issueOpenPositionPermit } from "@/lib/open-permit";
import { withFeeEstimateRetry } from "@/lib/rpc-fee-estimate";
import { APP_OPEN_PREPARE, MCP_OPEN_PREPARE } from "./surface-policy";

export type OpenPrepareCommand = {
  wallet: string;
  selection: OpenPositionSelection;
  amount: string;
  range: OpenRangeInput;
  floorBps: number;
  toleranceBps?: number;
};

export async function prepareOpen(command: OpenPrepareCommand, readSigningSecret: () => string,
  profile: typeof APP_OPEN_PREPARE | typeof MCP_OPEN_PREPARE) {
  const { wallet, selection, amount, range, floorBps, toleranceBps } = command;
  const { summary, transaction } = profile === APP_OPEN_PREPARE
    ? await withFeeEstimateRetry(() => buildAndSimulateOpenPosition(
      wallet, selection, amount, range, floorBps, toleranceBps, { enforceResaleFloor: false },
    ))
    : await buildAndSimulateOpenPosition(wallet, selection, amount, range, floorBps, toleranceBps);
  const permit = issueOpenPositionPermit(readSigningSecret(), {
    wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary,
  });
  // The engine already refreshed the blockhash and partial-signed with the NFT key.
  return { summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64") };
}
