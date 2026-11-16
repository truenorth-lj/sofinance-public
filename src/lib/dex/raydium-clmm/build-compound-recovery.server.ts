import "@/lib/engine-host";
import "server-only";
import { PublicKey } from "@solana/web3.js";
import { rpcConnection } from "@sofinance/engine/rpc";
import { buildAndSimulateCompoundRecovery } from "@sofinance/engine/compound-recovery";
import type { BuildCompoundRecovery } from "../compound-prepare";

async function sourcesAlreadyClosed(wallet: string, descriptors: unknown, error: unknown) {
  // The builder has already checked each wallet-derived source descriptor.
  // Only its explicit no-sources result can take this path; RPC/validation
  // errors must never be treated as a completed cleanup.
  if (!(error instanceof Error) || error.message !== "No recoverable harvest accounts; please verify original compound transaction status first" ||
    !Array.isArray(descriptors) || descriptors.length < 1 || descriptors.length > 2) return null;
  const accounts = descriptors.map((account: { address: string }) => account.address);
  const finalized = await rpcConnection().getMultipleAccountsInfo(accounts.map(address => new PublicKey(address)), "finalized");
  if (finalized.length !== accounts.length || finalized.some(account => account !== null)) return null;
  return { alreadyClosed: true as const, wallet, accounts };
}

export const buildRaydiumCompoundRecovery: BuildCompoundRecovery = ({ wallet, compoundAccounts }) =>
  buildAndSimulateCompoundRecovery(wallet, compoundAccounts).catch(async error => {
    const closed = await sourcesAlreadyClosed(wallet, compoundAccounts, error);
    if (closed) return closed;
    throw error;
  });
