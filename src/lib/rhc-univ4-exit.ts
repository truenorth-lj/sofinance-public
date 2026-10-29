import "@/lib/engine-host";
import "server-only";

import { lookupPositions, MAX_POSITION_LOOKUP, prepareExit, type ExitFlowResult, type PositionLookup } from "@sofinance/engine/protocols/uniswap-v4/exit-flow";
import { RHC_FEE_WALLET_ENV, parseRhcFeeRecipient } from "@sofinance/engine/protocols/uniswap-v4/fee-recipient";
import { createRhcClient } from "@sofinance/engine/rpc-evm/index";
import { type Address, getAddress, isAddress, type PublicClient } from "viem";
import { z } from "zod";

/**
 * Robinhood Chain Uniswap v4 exit (close position) BUILD + simulate (PR7). Returns unsigned PositionManager calldata;
 * nothing here signs or broadcasts. No fee on exit; the fee wallet env is only used (when set) to assert it receives
 * nothing. Position listing reads NFT ids supplied by the client (v4 PositionManager is not enumerable).
 */

const address = z.string().refine(v => isAddress(v, { strict: false }), "invalid address").transform(v => getAddress(v));
const tokenId = z.string().regex(/^[0-9]{1,30}$/, "expected an NFT id");

export const RhcExitRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("positions"), user: address, tokenIds: z.array(tokenId).min(1).max(MAX_POSITION_LOOKUP) }).strict(),
  z.object({ action: z.literal("prepare"), user: address, tokenId }).strict(),
]);
export type RhcExitRequest = z.infer<typeof RhcExitRequestSchema>;

export type RhcExitResponse = ExitFlowResult | { state: "positions"; positions: PositionLookup[] };

let stateClient: PublicClient | null = null;

export async function runRhcUniv4Exit(input: RhcExitRequest, options: { client?: PublicClient } = {}): Promise<RhcExitResponse> {
  const client = options.client ?? (stateClient ??= createRhcClient("state"));
  const user = input.user as Address;
  if (input.action === "positions") return { state: "positions", positions: await lookupPositions(client, user, input.tokenIds.map(BigInt)) };
  const feeRecipient = parseRhcFeeRecipient(process.env[RHC_FEE_WALLET_ENV]);
  return prepareExit({ client, feeRecipient }, { user, tokenId: BigInt(input.tokenId) });
}
