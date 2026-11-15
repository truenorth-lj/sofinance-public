import "@/lib/engine-host";
import "server-only";

import { PublicKey } from "@solana/web3.js";
import { formatAmount } from "@sofinance/engine/amount";
import { DEFAULT_ADD_TOLERANCE_BPS, DEFAULT_RESALE_FLOOR_BPS, NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { isJupiterUpstreamError, asJupiterUserError } from "@sofinance/engine/jupiter";
import { readSelectedPositionState, type PositionSelection } from "@sofinance/engine/selected-state";
import { readSwapFeeConfig } from "@sofinance/engine/swap/fee";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";
import type { PositionKey } from "@/lib/unified-positions/model";
import type { DexDepositInput, StepContext, StepResult } from "../adapter";
import { DexError } from "../errors";
import { assertFeeWalletConfigured } from "../fee-wallet.server";
import { feeRuleBps } from "../types";
import { raydiumClmmDescriptor } from "./descriptor";

const KEY_PREFIX = `${raydiumClmmDescriptor.id}:`;
const NOT_OWNER = "Wallet does not currently hold this Raydium CLMM position NFT";

function publicKey(value: string, label: string): string {
  try { return new PublicKey(value).toBase58(); }
  catch { throw new DexError("INVALID_REQUEST", `${label} must be a valid Solana address.`); }
}

/** Keep engine / provider errors inside the DEX contract without exposing endpoint credentials. */
function addError(error: unknown): unknown {
  if (error instanceof DexError) return error;
  // The generic route catches this control-flow exception to request browser-relayed Jupiter responses.
  if (error instanceof Error && error.name === "JupiterRelayMissingError") return error;
  if (error instanceof Error && error.message === NOT_OWNER) return new DexError("POSITION_NOT_FOUND", "That Raydium position is not held by this wallet.");
  if (error instanceof Error && error.name === "SwapFeeAccountMissingError") return new DexError("INPUT_TOKEN_UNSUPPORTED", error.message);
  if (isJupiterUpstreamError(error)) return new DexError("UPSTREAM", asJupiterUserError(error).message);
  const message = error instanceof Error ? error.message : "Please try again later.";
  return new DexError("UPSTREAM", `The Raydium add could not be prepared: ${message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[endpoint]")}`);
}

/** Adapt the existing app add flow; swaps, fee collection, simulation and instruction bytes stay there. */
export async function prepareRaydiumAdd(key: PositionKey, owner: string, input: DexDepositInput, context: StepContext): Promise<StepResult> {
  try {
    if (context.step !== 1) throw new DexError("INVALID_REQUEST", "Adding to a Raydium position is a single step.");
    if (!key.startsWith(KEY_PREFIX)) throw new DexError("INVALID_REQUEST", "That position key is not a Raydium position.");
    const positionMint = publicKey(key.slice(KEY_PREFIX.length), "The position mint");
    const wallet = publicKey(owner, "The wallet");
    const inputMint = publicKey(input.token, "The input mint");
    if (!/^\d{1,20}$/.test(input.amountRaw) || BigInt(input.amountRaw) <= 0n || BigInt(input.amountRaw) > 18_446_744_073_709_551_615n) {
      throw new DexError("INVALID_REQUEST", "The deposit must be a positive whole number of raw units within the token amount limit.");
    }
    let fee: ReturnType<typeof readSwapFeeConfig>;
    try { fee = readSwapFeeConfig(); }
    catch { throw new DexError("MISCONFIGURED", "The platform fee settings are invalid. Nothing was prepared."); }
    const expectedBps = feeRuleBps(raydiumClmmDescriptor.meta.feePolicy.add);
    assertFeeWalletConfigured({ dexId: raydiumClmmDescriptor.id, op: "add", charges: expectedBps > 0, feeWallet: fee.wallet?.toBase58() ?? null });
    if (fee.bps !== expectedBps) throw new DexError("MISCONFIGURED", "The platform fee settings do not match the Raydium add policy. Nothing was prepared.");
    const selection: PositionSelection = { positionMint, inputMint, inputKind: inputMint === NATIVE_SOL_MINT ? "native" : "token" };
    // Empty input is allowed only for this ownership / precision read: a non-owner is refused even
    // when it has no input ATA. The full builder reads again with allowEmptyInput=false, so the
    // fresh ownership, token restrictions and spendable balance checks remain on the execution path.
    const state = await readSelectedPositionState(wallet, selection, undefined, true, { displayPrices: false });
    if (inputMint !== state.mintA && inputMint !== state.mintB && !raydiumClmmDescriptor.meta.depositInputs.extra.some(token => token.id === inputMint)) {
      throw new DexError("INPUT_TOKEN_UNSUPPORTED", "Use one of the pool's tokens, USDC or SOL for this deposit.");
    }
    if (!Number.isInteger(state.inputDecimals) || state.inputDecimals < 0 || state.inputDecimals > 18) {
      throw new DexError("INPUT_TOKEN_UNSUPPORTED", "This token's precision is not supported for deposits.");
    }
    const amount = formatAmount(input.amountRaw, state.inputDecimals, state.inputDecimals);
    // Same terms as the dedicated app prepare: fixed swap slippage and add tolerance; no resale probe.
    const { transaction, summary } = await buildAndSimulateSelectedZap(wallet, selection, amount,
      DEFAULT_RESALE_FLOOR_BPS, DEFAULT_ADD_TOLERANCE_BPS, { enforceResaleFloor: false });
    if (summary.quote.feeBps !== expectedBps || summary.quote.feeWallet !== fee.wallet?.toBase58()) {
      throw new DexError("MISCONFIGURED", "The platform fee settings changed while preparing the deposit. Please try again.");
    }
    return { step: 1, of: 1, label: "Add to the position", done: true, prepared: {
      kind: "solana-tx", transaction: Buffer.from(transaction.serialize()).toString("base64"),
      lastValidBlockHeight: summary.lastValidBlockHeight, positionMint,
    } };
  } catch (error) {
    throw addError(error);
  }
}
