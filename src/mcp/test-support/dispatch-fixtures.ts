import { testKeypair } from "@/lib/test-support/send-fixtures";
import type { ToolName } from "../tool-definitions";
import type * as tools from "../tools";
export const wallet = testKeypair(1).publicKey.toBase58();
export const otherWallet = testKeypair(2).publicKey.toBase58();
const mint = testKeypair(3).publicKey.toBase58();
const pool = testKeypair(4).publicKey.toBase58();
const nftMint = testKeypair(5).publicKey.toBase58();
export const VALID_ARGS = {
  lp_withdraw_prepare:{wallet,positionMint:mint,percent:100},
  lp_withdraw_submit:{wallet,signedTransaction:"AA",permit:"p",summary:{}},
  positions_list: { wallet },
  lp_add_quote: { wallet, positionMint: mint, inputMint: mint, inputKind: "token", amount: "1" },
  lp_add_prepare: { wallet, positionMint: mint, inputMint: mint, inputKind: "token", amount: "1" },
  lp_compound_quote: { wallet, positionMint: mint },
  lp_compound_prepare: { wallet, positionMint: mint },
  lp_add_submit: {
    signedTransaction: "AA", permit: "p", wallet, selection: { positionMint: mint, inputMint: mint, inputKind: "token" },
    requested: "1", expectedLiquidity: "1", startingLiquidity: "1", floorBps: 9900, expiresAt: 1, lastValidBlockHeight: 1,
    rangeSide: "inside", startingBalances: { input: "1", a: "1", b: "1" },
  },
  lp_compound_submit: { signedTransaction: "AA", permit: "p", wallet, summary: {} },
  lp_open_quote: { wallet, poolId: pool, inputMint: mint, inputKind: "token", amount: "1" },
  lp_open_prepare: { wallet, poolId: pool, inputMint: mint, inputKind: "token", amount: "1", nftMint },
  lp_open_submit: { signedTransaction: "AA", permit: "p", wallet, summary: {} },
  position_get_performance: { positionMint: mint, wallet },
  position_get_range_status: { positionMint: mint, wallet },
  pools_list: {},
  pool_get_range_apr: { poolId: pool },
  tx_status: { signature: "1".repeat(64) },
} satisfies Record<ToolName, Record<string, unknown>>;
export const IMPLEMENTATION = {
  lp_withdraw_prepare:"prepareWithdraw",lp_withdraw_submit:"submitWithdrawTransaction",
  positions_list: "listPositions", lp_add_quote: "quoteAddLiquidity", lp_add_prepare: "prepareTransaction",
  lp_compound_quote: "quoteCompound", lp_compound_prepare: "prepareCompoundTransaction",
  lp_add_submit: "submitSignedTransaction", lp_compound_submit: "submitCompoundTransaction",
  lp_open_quote: "quoteOpenPosition", lp_open_prepare: "prepareOpenPosition", lp_open_submit: "submitOpenPosition",
  position_get_performance: "getPositionPerformance", position_get_range_status: "getPositionRangeStatus",
  pools_list: "listRwaPairs", pool_get_range_apr: "getPoolRangeApr", tx_status: "txStatus",
} as const satisfies Record<ToolName, keyof typeof tools>;
