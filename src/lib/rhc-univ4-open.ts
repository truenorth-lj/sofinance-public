import "@/lib/engine-host";
import "server-only";

import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { RHC_FEE_WALLET_ENV } from "@sofinance/engine/protocols/uniswap-v4/fee-recipient";
import { finalizeOpen, type OpenFlowResult, permitFromJson, prepareOpen } from "@sofinance/engine/protocols/uniswap-v4/open-flow";
import { createRhcClient } from "@sofinance/engine/rpc-evm/index";
import { type Address, getAddress, type Hex, isAddress, isAddressEqual, type PublicClient } from "viem";
import { z } from "zod";

/**
 * Robinhood Chain Uniswap v4 open-position BUILD + simulate (PR2). Returns unsigned calldata and Permit2 typed data;
 * nothing here signs or broadcasts. State overrides are never accepted from a request. The fee wallet comes from the
 * server-only `RHC_UNIV4_FEE_WALLET` (EIP-55 checksummed); unset or invalid → every open fails closed.
 */

const address = z.string().refine(v => isAddress(v, { strict: false }), "invalid address").transform(v => getAddress(v));
const uintString = z.string().regex(/^[0-9]{1,78}$/, "expected a base-10 integer string");
const tick = z.number().int().min(-887272).max(887272);

const base = z.object({
  poolId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  user: address,
  depositToken: address,
  amount: uintString,
  tickLower: tick,
  tickUpper: tick,
});

export const RhcOpenRequestSchema = z.discriminatedUnion("action", [
  base.extend({ action: z.literal("prepare") }).strict(),
  base.extend({
    action: z.literal("finalize"),
    attempt: z.number().int().min(0).max(10),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    permit: z.object({
      details: z.object({ token: address, amount: uintString, expiration: z.number().int().nonnegative(), nonce: z.number().int().nonnegative() }).strict(),
      spender: address,
      sigDeadline: uintString,
    }).strict(),
  }).strict(),
]);
export type RhcOpenRequest = z.infer<typeof RhcOpenRequestSchema>;

let stateClient: PublicClient | null = null;

export class RhcOpenInputError extends Error {}

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
