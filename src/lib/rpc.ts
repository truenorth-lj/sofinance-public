import "server-only";

import { Connection } from "@solana/web3.js";

export function rpcConnection() {
  const endpoint = process.env.SOLANA_RPC_URL?.trim();
  if (!endpoint) throw new Error("Server-side SOLANA_RPC_URL not yet configured");
  return new Connection(endpoint, "confirmed");
}
