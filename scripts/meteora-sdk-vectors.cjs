/* eslint-disable */
/**
 * Regenerates the Meteora DLMM SDK reference vectors pinned in
 * packages/engine/src/protocols/meteora/{open,liquidity}.test.ts (instruction bytes and account order from
 * `@meteora-ag/dlmm` 1.9.14's IDL through the Anchor coder / `program.methods.*.accountsPartial(...).instruction()`).
 *
 * Offline: builds instructions only, makes no RPC call and signs nothing. The SDK is NOT a dependency of this repo
 * (the engine hand-encodes the instructions); install it in a scratch directory and point NODE_PATH at it:
 *
 *   npm i --prefix /tmp/dlmm-vectors @meteora-ag/dlmm@1.9.14
 *   NODE_PATH=/tmp/dlmm-vectors/node_modules node scripts/meteora-sdk-vectors.cjs
 *
 * Compare the printed hex / account rows with the `SDK` constants and `rows(...)` expectations in those tests.
 */
const { AnchorProvider, BN, BorshInstructionCoder, Program, Wallet } = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const dlmm = require("@meteora-ag/dlmm");

const path = require("node:path");
const fs = require("node:fs");
const sdkDir = path.dirname(require.resolve("@meteora-ag/dlmm")).replace(/[\\/]dist$/, "");
const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkDir, "package.json"), "utf8")).version;
if (sdkVersion !== "1.9.14") console.warn(`warning: vectors are pinned to @meteora-ag/dlmm 1.9.14, found ${sdkVersion}`);

const idl = dlmm.IDL;
const coder = new BorshInstructionCoder(idl);
const parameteres = new Array(64).fill(0);
const spot = (min, max) => ({ min_bin_id: min, max_bin_id: max, strategy_type: { SpotImBalanced: {} }, parameteres });
const hex = (name, args) => coder.encode(name, args).toString("hex");

// Placeholder keys used by liquidity.test.ts: sender 1, position 2, reserves 3/4, mints 5/6, user ATAs 7/8, programs 9/10.
const k = (seed) => new PublicKey(Buffer.alloc(32, seed));
const POOL = new PublicKey("8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh");
const PROGRAM_ID = new PublicKey(dlmm.LBCLMM_PROGRAM_IDS ? dlmm.LBCLMM_PROGRAM_IDS["mainnet-beta"] : "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const bitmapExtension = PublicKey.findProgramAddressSync([Buffer.from("bitmap"), POOL.toBuffer()], PROGRAM_ID)[0];

// The connection is never used (instruction building only); the URL is a placeholder, not an RPC endpoint we call.
const provider = new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {});
const program = new Program({ ...idl, address: PROGRAM_ID.toBase58() }, provider);
const rows = (ix) => ix.keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]);
const common = {
  lbPair: POOL, position: k(2), sender: k(1), reserveX: k(3), reserveY: k(4), tokenXMint: k(5), tokenYMint: k(6),
  userTokenX: k(7), userTokenY: k(8), tokenXProgram: k(9), tokenYProgram: k(10), tokenProgramX: k(9), tokenProgramY: k(10),
  memoProgram: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
};
const binArrayMetas = (indexes) => indexes.map((index) => {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(index));
  const [pubkey] = PublicKey.findProgramAddressSync([Buffer.from("bin_array"), POOL.toBuffer(), buf], PROGRAM_ID);
  return { pubkey, isSigner: false, isWritable: true };
});

async function main() {
  const out = { sdkVersion, open: {}, liquidity: {} };
  // open.test.ts
  out.open.initializePosition = hex("initialize_position", { lower_bin_id: -35, width: 70 });
  out.open.addBalanced = hex("add_liquidity_by_strategy2", {
    liquidity_parameter: { amount_x: new BN("123456789"), amount_y: new BN("987654321"), active_id: -12, max_active_bin_slippage: 50, strategy_parameters: spot(-40, 29) },
    remaining_accounts_info: { slices: [] },
  });
  out.open.addOneSide = hex("add_liquidity_by_strategy2", {
    liquidity_parameter: { amount_x: new BN("5"), amount_y: new BN("0"), active_id: 7, max_active_bin_slippage: 3, strategy_parameters: spot(8, 20) },
    remaining_accounts_info: { slices: [] },
  });
  out.open.closePosition2 = hex("close_position2", {});

  // liquidity.test.ts
  const claim = await program.methods.claimFee2(-35, 34, { slices: [] })
    .accountsPartial({ ...common, program: PROGRAM_ID }).remainingAccounts(binArrayMetas([-1, 0])).instruction();
  out.liquidity.claimFee2 = { data: claim.data.toString("hex"), accounts: rows(claim) };
  const remove = async (from, to, bps, withBitmap, indexes) => {
    const ix = await program.methods.removeLiquidityByRange2(from, to, bps, { slices: [] })
      .accountsPartial({ ...common, binArrayBitmapExtension: withBitmap ? bitmapExtension : null, program: PROGRAM_ID })
      .remainingAccounts(binArrayMetas(indexes)).instruction();
    return { data: ix.data.toString("hex"), accounts: rows(ix) };
  };
  out.liquidity.remove10000 = await remove(-35, 34, 10_000, true, [-1, 0]);
  out.liquidity.remove5000 = await remove(46031, 46090, 5_000, true, [657, 658]);
  const add = await program.methods.addLiquidityByStrategy2(
    { amountX: new BN(1), amountY: new BN(2), activeId: 46061, maxActiveBinSlippage: 5,
      strategyParameters: { minBinId: 46031, maxBinId: 46090, strategyType: { spotImBalanced: {} }, parameteres } },
    { slices: [] },
  ).accountsPartial({ ...common, binArrayBitmapExtension: bitmapExtension, program: PROGRAM_ID })
    .remainingAccounts(binArrayMetas([657, 658])).instruction();
  out.liquidity.addWithBitmap = { data: add.data.toString("hex"), accounts: rows(add).slice(0, 3) };
  out.bitmapExtension = bitmapExtension.toBase58();
  console.log(JSON.stringify(out, null, 1));
}

main().catch((error) => { console.error(error); process.exit(1); });
