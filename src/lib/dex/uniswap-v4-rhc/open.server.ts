import "@/lib/engine-host";
import "server-only";

import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { RHC_FEE_WALLET_ENV } from "@sofinance/engine/protocols/uniswap-v4/fee-recipient";
import { finalizeOpen, type OpenFlowResult, permitFromJson, prepareOpen } from "@sofinance/engine/protocols/uniswap-v4/open-flow";
import { createRhcClient } from "@sofinance/engine/rpc-evm/index";
import { type Address, type Hex, isAddressEqual, type PublicClient } from "viem";
import { EvmLiquidityInputError as RhcOpenInputError } from "../evm-liquidity";
import type { RhcOpenRequest } from "./liquidity-input";

/**
 * Robinhood Chain Uniswap v4 open-position BUILD + simulate (PR2). Returns unsigned calldata and Permit2 typed data;
 * nothing here signs or broadcasts. State overrides are never accepted from a request. The fee wallet comes from the
 * server-only `RHC_UNIV4_FEE_WALLET` (EIP-55 checksummed); unset or invalid → every open fails closed.
 */

let stateClient: PublicClient | null = null;

export async function runRhcUniv4Open(input: RhcOpenRequest, options: { client?: PublicClient } = {}): Promise<OpenFlowResult> {
  const pool = UNIV4_RHC_ALLOWLISTED_POOLS.find(p => p.poolId.toLowerCase() === input.poolId.toLowerCase());
  if (!pool) throw new RhcOpenInputError("Pool is not allowlisted");
  const depositToken = [pool.currency0.address, pool.currency1.address].find(t => isAddressEqual(t, input.depositToken as Address));
  if (!depositToken) throw new RhcOpenInputError("Deposit token is not in this pool");
  const amount = BigInt(input.amount);
  if (amount <= 0n) throw new RhcOpenInputError("Amount must be positive");
  const client = options.client ?? (stateClient ??= createRhcClient("state"));
  const feeRecipient = process.env[RHC_FEE_WALLET_ENV];
  const req = { pool, user: input.user as Address, depositToken, amount, tickLower: input.tickLower, tickUpper: input.tickUpper };
  if (input.action === "prepare") return prepareOpen({ client, feeRecipient }, req);
  return finalizeOpen({ client, feeRecipient }, { ...req, permit: permitFromJson(input.permit as Parameters<typeof permitFromJson>[0]), signature: input.signature as Hex, attempt: input.attempt });
}
