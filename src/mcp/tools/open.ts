import "@/lib/engine-host";
import { PublicKey } from "@solana/web3.js";
import { randomBytes } from "crypto";
import { MCP_OPEN_PREPARE } from "@/server/transactions/surface-policy";
import { CompoundSendError, notSentRetryMessage, sanitizePublicError } from "../../lib/public-error";
import { createSignToken } from "../../lib/pending-sign-token";
import { buildSignUrl } from "../../lib/public-urls";
import { rangeInputFromFields } from "@sofinance/engine/open-range";
import { getOpenPositionQuoteBundle } from "@sofinance/engine/open-quote";
import { prepareOpen } from "@/server/transactions/open-prepare";
import { assertSolInputAllowed } from "@/lib/sol-input-policy";
import { submitOpenPositionFromParts } from "../../lib/open-send";
import type { OpenPositionSummary } from "@sofinance/engine/open-types";
import type { PrepareOpenPositionInput, QuoteOpenPositionInput, SubmitOpenPositionInput } from "../schemas";
import { capturePrepareSigningSecret } from "./prepare-secret";

function openRangeFromInput(input: QuoteOpenPositionInput) {
  return rangeInputFromFields(input.rangePreset, input.minPrice, input.maxPrice);
}

/**
 * Quote opening a new Raydium CLMM position in a pool (no existing NFT required).
 * Swaps the input asset toward the in-range pool ratio via Jupiter, then sizes liquidity.
 */
export async function quoteOpenPosition(input: QuoteOpenPositionInput) {
  const selection = {
    poolId: input.poolId,
    inputMint: input.inputMint,
    inputKind: input.inputKind,
  };
  assertSolInputAllowed(selection);
  const { quote } = await getOpenPositionQuoteBundle(
    input.wallet, selection, input.amount, openRangeFromInput(input),
    input.resaleFloorBps, input.slippageToleranceBps,
  );
  return quote;
}

/**
 * Placeholder mint for MCP prepares without `nftMint`: random bytes, so no secret
 * exists anywhere. The returned transaction is a preview; `/app/sign/<token>`
 * generates the real mint in the browser and re-prepares (wallet signs first).
 */
export function previewOnlyMintAddress(): string {
  // Random bytes that decode to a valid ed25519 point (the engine requires an on-curve
  // mint): a usable public key whose secret key nobody knows. ~50% of draws qualify.
  for (;;) {
    const bytes = randomBytes(32);
    if (PublicKey.isOnCurve(bytes) && !bytes.every(byte => byte === 0)) return new PublicKey(bytes).toBase58();
  }
}

/**
 * Prepare an unsigned open-position transaction. Prefer `nftMint` from an agent-held
 * Keypair: the server never signs. After the wallet signs, add the mint signature
 * to the transaction the wallet returns, zero the secret, then submit_open_position.
 * Without `nftMint`, use signUrl: the sign page creates the mint in the browser.
 */
export async function prepareOpenPosition(input: PrepareOpenPositionInput) {
  const signingSecret = capturePrepareSigningSecret();
  const selection = {
    poolId: input.poolId,
    inputMint: input.inputMint,
    inputKind: input.inputKind,
  };
  const range = openRangeFromInput(input);
  const browserMint = !input.nftMint;
  const { summary, permit, unsignedTransaction } = await prepareOpen({
    wallet: input.wallet, selection, amount: input.amount, range,
    floorBps: input.resaleFloorBps, toleranceBps: input.slippageToleranceBps,
    nftMint: input.nftMint ?? previewOnlyMintAddress(),
  }, signingSecret, MCP_OPEN_PREPARE);
  const submitArgs = { permit, wallet: input.wallet, summary };
  const signToken = await createSignToken(
    {
      kind: "open-position",
      wallet: input.wallet,
      unsignedTransaction,
      permit,
      submitArgs,
      expiresAt: summary.expiresAt,
      ...(browserMint ? { openRequest: {
        selection, amount: input.amount, range, floorBps: input.resaleFloorBps,
        ...(input.slippageToleranceBps === undefined ? {} : { toleranceBps: input.slippageToleranceBps }),
      } } : {}),
    },
    signingSecret(),
  );
  return {
    unsignedTransaction,
    permit,
    summary,
    signToken,
    signUrl: buildSignUrl(signToken),
    instructions: {
      message: browserMint
        ? "No nftMint was passed, so open signUrl in a browser: the sign page generates the position NFT mint there, re-prepares, has the wallet sign FIRST, then adds the mint signature. unsignedTransaction/summary here are a preview built with a placeholder mint and cannot be submitted directly. To submit programmatically, call prepare_open_position again with your own nftMint."
        : "Sign unsignedTransaction with the wallet FIRST, then add the NFT mint signature to the transaction the wallet returns without modifying the message, then call submit_open_position with { signedTransaction, permit, wallet, summary }. Pass summary back exactly as returned. signUrl cannot add the mint signature; use programmatic submit when you generated nftMint.",
    },
  };
}

/**
 * Submit a signed open-position transaction. Dedicated tool (not submit_signed_transaction)
 * because the v0 message has two required signers (wallet + ephemeral NFT mint).
 */
export async function submitOpenPosition(input: SubmitOpenPositionInput) {
  try {
    return await submitOpenPositionFromParts({
      signedTransaction: input.signedTransaction,
      unsignedTransaction: input.unsignedTransaction,
      permit: input.permit,
      wallet: input.wallet,
      summary: input.summary as OpenPositionSummary,
    });
  } catch (error) {
    if (error instanceof CompoundSendError) {
      const message = sanitizePublicError(error.cause ?? error, "Open-position transaction broadcast failed");
      throw new Error(error.sent === false ? notSentRetryMessage(message) : message);
    }
    throw new Error(notSentRetryMessage(sanitizePublicError(error, "Open-position transaction broadcast failed")));
  }
}
