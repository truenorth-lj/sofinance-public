/** Existing native HTTP validation, independent of RPC clients and transaction builders. */
import { MAX_POSITION_LOOKUP } from "@sofinance/engine/protocols/uniswap-v4/exit-limits";
import { getAddress, isAddress } from "viem";
import { z } from "zod";

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

const tokenId = z.string().regex(/^[0-9]{1,30}$/, "expected an NFT id");

export const RhcExitRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("positions"), user: address, tokenIds: z.array(tokenId).min(1).max(MAX_POSITION_LOOKUP) }).strict(),
  z.object({ action: z.literal("prepare"), user: address, tokenId }).strict(),
]);
export type RhcExitRequest = z.infer<typeof RhcExitRequestSchema>;
