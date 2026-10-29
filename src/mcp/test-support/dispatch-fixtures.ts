import { testKeypair } from "@/lib/test-support/send-fixtures";
import type { ToolName } from "../tool-definitions";
import type * as tools from "../tools";
export const wallet = testKeypair(1).publicKey.toBase58();
export const otherWallet = testKeypair(2).publicKey.toBase58();
const mint = testKeypair(3).publicKey.toBase58();
const pool = testKeypair(4).publicKey.toBase58();
const nftMint = testKeypair(5).publicKey.toBase58();
export const VALID_ARGS = {
  prepare_withdraw:{wallet,positionMint:mint,percent:100},
  submit_withdraw:{wallet,signedTransaction:"AA",permit:"p",summary:{}},
  list_positions: { wallet },
  quote_add_liquidity: { wallet, positionMint: mint, inputMint: mint, inputKind: "token", amount: "1" },
  prepare_transaction: { wallet, positionMint: mint, inputMint: mint, inputKind: "token", amount: "1" },
  quote_compound: { wallet, positionMint: mint },
  prepare_compound_transaction: { wallet, positionMint: mint },
  submit_signed_transaction: {
    signedTransaction: "AA", permit: "p", wallet, selection: { positionMint: mint, inputMint: mint, inputKind: "token" },
    requested: "1", expectedLiquidity: "1", startingLiquidity: "1", floorBps: 9900, expiresAt: 1, lastValidBlockHeight: 1,
    rangeSide: "inside", startingBalances: { input: "1", a: "1", b: "1" },
  },
  submit_compound_transaction: { signedTransaction: "AA", permit: "p", wallet, summary: {} },
  quote_open_position: { wallet, poolId: pool, inputMint: mint, inputKind: "token", amount: "1" },
  prepare_open_position: { wallet, poolId: pool, inputMint: mint, inputKind: "token", amount: "1", nftMint },
  submit_open_position: { signedTransaction: "AA", permit: "p", wallet, summary: {} },
  get_position_performance: { positionMint: mint, wallet },
  get_position_range_status: { positionMint: mint, wallet },
  list_rwa_pairs: {},
} satisfies Record<ToolName, Record<string, unknown>>;
export const IMPLEMENTATION = {
  prepare_withdraw:"prepareWithdraw",submit_withdraw:"submitWithdrawTransaction",
  list_positions: "listPositions", quote_add_liquidity: "quoteAddLiquidity", prepare_transaction: "prepareTransaction",
  quote_compound: "quoteCompound", prepare_compound_transaction: "prepareCompoundTransaction",
  submit_signed_transaction: "submitSignedTransaction", submit_compound_transaction: "submitCompoundTransaction",
  quote_open_position: "quoteOpenPosition", prepare_open_position: "prepareOpenPosition", submit_open_position: "submitOpenPosition",
  get_position_performance: "getPositionPerformance", get_position_range_status: "getPositionRangeStatus",
  list_rwa_pairs: "listRwaPairs",
} as const satisfies Record<ToolName, keyof typeof tools>;
