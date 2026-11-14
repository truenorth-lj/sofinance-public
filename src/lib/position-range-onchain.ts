import "@/lib/engine-host";
import "server-only";

import { readRaydiumRangeFacts, type RaydiumRangeFacts } from "@sofinance/engine/protocols/raydium/position-snapshot";
import { rpcConnection } from "@sofinance/engine/rpc";
import type { Connection } from "@solana/web3.js";

export type PositionRangeFacts = RaydiumRangeFacts;

export async function readPositionRangeFacts(
  positionMint: string,
  connection: Connection = rpcConnection(),
): Promise<PositionRangeFacts> {
  return readRaydiumRangeFacts(positionMint, connection);
}
