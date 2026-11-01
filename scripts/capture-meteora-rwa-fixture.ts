/**
 * Read-only capture of the Meteora DLMM RWA pools used by the engine's Meteora builder tests
 * (`packages/engine/src/fixtures/meteora-dlmm-rwa-t22.json`). Public program state only: the two LbPair
 * accounts, their Token-2022 mints, the bitmap extension PDAs, which bin arrays around the active bin exist,
 * and the cluster's rent-exempt minimums. No wallets, keys, signatures or credentials are read or written.
 *
 * Usage: pnpm exec tsx scripts/capture-meteora-rwa-fixture.ts [publicRpcUrl]
 * Defaults to the public mainnet endpoint; it never reads an RPC URL from the environment.
 */
import { writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { BIN_ARRAY_ACCOUNT_LEN, decodeLbPair, meteoraBinArrayAddress, meteoraBinArrayIndex } from "@sofinance/engine/protocols/meteora/accounts";
import { meteoraBitmapExtensionAddress } from "@sofinance/engine/protocols/meteora/open";
import { METEORA_POSITION_BASE_LEN } from "@sofinance/engine/protocols/meteora/position";

const POOLS = ["8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh", "5pw5tNUaZJpUCnYjZ1V3gd7XkLbrb4zA9pir4LFph2mj"];
const OUT = "packages/engine/src/fixtures/meteora-dlmm-rwa-t22.json";

async function main() {
  const connection = new Connection(process.argv[2] ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const slot = await connection.getSlot();
  const pairInfos = await connection.getMultipleAccountsInfo(POOLS.map((pool) => new PublicKey(pool)));
  const pools: Record<string, unknown> = {};
  const mints = new Set<string>();
  for (const [i, pool] of POOLS.entries()) {
    const info = pairInfos[i];
    if (!info) throw new Error(`missing LbPair ${pool}`);
    const state = decodeLbPair(info.data);
    mints.add(state.tokenXMint).add(state.tokenYMint);
    const active = meteoraBinArrayIndex(state.activeId);
    const indexes = [active - 2, active - 1, active, active + 1, active + 2];
    const bitmapExtension = meteoraBitmapExtensionAddress(pool).toBase58();
    const infos = await connection.getMultipleAccountsInfo([bitmapExtension, ...indexes.map((index) => meteoraBinArrayAddress(pool, index))].map((key) => new PublicKey(key)));
    pools[pool] = {
      owner: info.owner.toBase58(),
      data: info.data.toString("base64"),
      bitmapExtension: { address: bitmapExtension, exists: !!infos[0] },
      binArrays: Object.fromEntries(indexes.map((index, j) => [String(index), { address: meteoraBinArrayAddress(pool, index), exists: !!infos[j + 1] }])),
    };
  }
  const mintKeys = [...mints];
  const mintInfos = await connection.getMultipleAccountsInfo(mintKeys.map((mint) => new PublicKey(mint)));
  const mintOut = Object.fromEntries(mintKeys.map((mint, i) => {
    const info = mintInfos[i];
    if (!info) throw new Error(`missing mint ${mint}`);
    return [mint, { owner: info.owner.toBase58(), data: info.data.toString("base64") }];
  }));
  const sizes = [0, METEORA_POSITION_BASE_LEN, BIN_ARRAY_ACCOUNT_LEN];
  const rent = Object.fromEntries(await Promise.all(sizes.map(async (size) => [String(size), await connection.getMinimumBalanceForRentExemption(size)])));
  writeFileSync(OUT, `${JSON.stringify({ slot, capturedAt: new Date().toISOString(), pools, mints: mintOut, rentExemptMinimum: rent }, null, 2)}\n`);
  console.log(`wrote ${OUT} at slot ${slot}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
