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
  nftMint: string;
};

export async function prepareOpen(command: OpenPrepareCommand, readSigningSecret: () => string,
  profile: typeof APP_OPEN_PREPARE | typeof MCP_OPEN_PREPARE) {
  const { wallet, selection, amount, range, floorBps, toleranceBps, nftMint } = command;
  const { summary, transaction } = profile === APP_OPEN_PREPARE
    ? await withFeeEstimateRetry(() => buildAndSimulateOpenPosition(
      wallet, selection, amount, range, floorBps, toleranceBps, { enforceResaleFloor: false, nftMint },
    ))
    : await buildAndSimulateOpenPosition(wallet, selection, amount, range, floorBps, toleranceBps, { nftMint });
  const permit = issueOpenPositionPermit(readSigningSecret(), {
    wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary,
  });
  // Fully unsigned: the client (or MCP agent) signs the wallet first, then the NFT mint.
  return { summary, permit, unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64") };
}
