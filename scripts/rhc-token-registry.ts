/* eslint-disable no-console -- CLI summary is the intended output. */
/**
 * Regenerates `src/lib/pool-metrics/rhc-tokens.json`: the Robinhood Chain (4663) entries of the token
 * registry, i.e. every underlying that has both a Robinhood token and an Ondo token.
 *
 * Manual / offline only. Never run it from the cron or CI. It scans factory events, which the cron must
 * not do (PM rule 2026-10-29: the cron does state reads only). Review the diff and commit it by hand; a
 * new underlying in the diff is how a new same-asset pair shows up.
 *
 *   pnpm rhc:tokens          # or: node --env-file-if-exists=.env.local --import tsx scripts/rhc-token-registry.ts
 *   pnpm rhc:tokens --check  # exit 1 if the checked-in file is out of date; writes nothing
 *
 * Uses RHC_RPC_URL if set (never printed), otherwise the public RPC. Calls made:
 * 1. Robinhood asset registry, `GET https://api.robinhood.com/rhj/assets` (ticker, ISIN, chain-4663 address);
 * 2. Ondo GM factory `eth_getLogs` (token deployed: topic1 = token, topic2 = beacon) over the chain, 10M blocks per call;
 * 3. one multicall (symbol + decimals of every candidate token), one `eth_getStorageAt` per candidate for its
 *    EIP-1967 beacon slot, and both beacons' `implementation()` (recorded; the cron re-checks it).
 * A token is kept only when its beacon slot holds its issuer's beacon. Ondo ticker = symbol minus `on`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi, toHex, decodeFunctionResult, type Address, type Hex } from "viem";
import {
  RHC_BEACON_SLOT, RHC_ISSUER_BEACONS, RHC_MULTICALL3, RHC_PUBLIC_RPC, type RhcRegistryFile, type RhcRegistryToken,
} from "../src/lib/pool-metrics/rhc-registry";

const OUT = fileURLToPath(new URL("../src/lib/pool-metrics/rhc-tokens.json", import.meta.url));
const ROBINHOOD_REGISTRY = "https://api.robinhood.com/rhj/assets";
const ONDO_FACTORY = "0x834932218bc3ccc9fca0c774635f8d093875b3e7";
const ONDO_TOKEN_DEPLOYED = "0x7a17f95e4511303523685c183ebe78033998e1dfe6e39cfcec71d2a554524623";
const LOG_STEP = 10_000_000n;

const client = createPublicClient({ transport: http(process.env.RHC_RPC_URL || RHC_PUBLIC_RPC, { retryCount: 4, retryDelay: 1500 }) });
const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const beaconAbi = parseAbi(["function implementation() view returns (address)"]);
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) view returns (Result[] returnData)",
]);
/** Multicall3 cannot read raw storage, so the beacon slot is read through an `eth_getStorageAt` JSON-RPC batch. */
async function storageAt(addresses: readonly string[]): Promise<Hex[]> {
  return Promise.all(addresses.map((address) => client.getStorageAt({ address: address as Hex, slot: RHC_BEACON_SLOT }).then((v) => v ?? "0x")));
}
const slotAddress = (word: Hex) => (word.length >= 42 && BigInt(word) !== 0n ? getAddress(`0x${word.slice(-40)}`) : null);

type RhAsset = { tokenSymbol: string; tokenName?: string; isin?: string; status?: string; deployments?: { contractAddress: string; chainId: number }[] };

async function robinhoodTokens() {
  const response = await fetch(ROBINHOOD_REGISTRY, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Robinhood registry HTTP ${response.status}`);
  const { assets } = (await response.json()) as { assets: RhAsset[] };
  return assets.flatMap((asset) => (asset.deployments ?? []).filter((d) => d.chainId === 4663).map((d) => ({
    address: getAddress(d.contractAddress), ticker: asset.tokenSymbol.trim().toUpperCase(), isin: asset.isin || undefined, active: asset.status === "ASSET_STATUS_ACTIVE",
  })));
}

async function ondoTokens() {
  const head = await client.getBlockNumber();
  const tokens = new Set<Address>();
  for (let from = 0n; from <= head; from += LOG_STEP) {
    const to = from + LOG_STEP - 1n > head ? head : from + LOG_STEP - 1n;
    const logs = (await client.request({ method: "eth_getLogs", params: [{ address: ONDO_FACTORY, fromBlock: toHex(from), toBlock: toHex(to), topics: [ONDO_TOKEN_DEPLOYED] }] })) as { topics: Hex[] }[];
    for (const log of logs) if (log.topics[1]) tokens.add(getAddress(`0x${log.topics[1].slice(-40)}`));
  }
  return [...tokens];
}

async function main() {
  const check = process.argv.includes("--check");
  const [robinhood, ondo] = await Promise.all([robinhoodTokens(), ondoTokens()]);
  const addresses = [...new Set([...robinhood.map((t) => t.address), ...ondo])];
  const calls = addresses.flatMap((target) => (["symbol", "decimals"] as const).map((functionName) => ({ target, allowFailure: true, callData: encodeFunctionData({ abi: erc20, functionName }) })));
  const [results, beacons] = await Promise.all([
    client.readContract({ address: RHC_MULTICALL3, abi: multicallAbi, functionName: "aggregate3", args: [calls] }),
    storageAt(addresses),
  ]);
  const onchain = new Map(addresses.map((address, i) => {
    const read = (j: number, functionName: "symbol" | "decimals") => {
      const r = results[i * 2 + j]!;
      return r.success ? decodeFunctionResult({ abi: erc20, functionName, data: r.returnData }) : null;
    };
    return [address, { symbol: read(0, "symbol") as string | null, decimals: read(1, "decimals") as number | null, beacon: slotAddress(beacons[i]!) }];
  }));

  const verified = (address: Address, issuer: keyof typeof RHC_ISSUER_BEACONS) => onchain.get(address)?.beacon?.toLowerCase() === RHC_ISSUER_BEACONS[issuer].toLowerCase();
  const ondoByTicker = new Map<string, Address>();
  for (const address of ondo) {
    const symbol = onchain.get(address)?.symbol?.trim();
    if (!symbol || !verified(address, "ondo") || !/on$/.test(symbol)) continue;
    ondoByTicker.set(symbol.slice(0, -2).toUpperCase(), address);
  }
  const tokens: RhcRegistryToken[] = [];
  const unpairedOndo: string[] = [];
  for (const [ticker, ondoAddress] of [...ondoByTicker].sort(([a], [b]) => a.localeCompare(b))) {
    const rh = robinhood.find((t) => t.ticker === ticker && t.active && verified(t.address, "robinhood"));
    if (!rh) { unpairedOndo.push(ticker); continue; }
    for (const [issuer, address, isin] of [["robinhood", rh.address, rh.isin], ["ondo", ondoAddress, undefined]] as const) {
      const info = onchain.get(address)!;
      tokens.push({
        chain: "robinhood", address, symbol: info.symbol!.trim(), issuer, underlying: ticker, ...(isin ? { isin } : {}),
        decimals: info.decimals ?? 18, verification: { method: "issuer-beacon", beacon: RHC_ISSUER_BEACONS[issuer] },
      });
    }
  }
  const implementation = (address: Address) => client.readContract({ address, abi: beaconAbi, functionName: "implementation" }).then(getAddress);
  const beaconsOut = {
    robinhood: { address: RHC_ISSUER_BEACONS.robinhood, implementation: await implementation(RHC_ISSUER_BEACONS.robinhood) },
    ondo: { address: RHC_ISSUER_BEACONS.ondo, implementation: await implementation(RHC_ISSUER_BEACONS.ondo) },
  };
  const file: RhcRegistryFile = { chainId: 4663, beacons: beaconsOut, unpairedOndo, tokens };
  const next = `${JSON.stringify(file, null, 2)}\n`;
  const current = (() => { try { return readFileSync(OUT, "utf8"); } catch { return ""; } })();
  console.log(`robinhood registry: ${robinhood.length} chain-4663 tokens; ondo factory: ${ondo.length} tokens (${ondoByTicker.size} beacon-verified)`);
  console.log(`pairs: ${tokens.length / 2} (${[...new Set(tokens.map((t) => t.underlying))].join(" ")}); ondo without a Robinhood token: ${unpairedOndo.join(" ") || "none"}`);
  if (check) { console.log(current === next ? "rhc-tokens.json is up to date" : "rhc-tokens.json is OUT OF DATE"); process.exit(current === next ? 0 : 1); }
  if (current === next) console.log("rhc-tokens.json unchanged");
  else { writeFileSync(OUT, next); console.log(`wrote ${OUT}; review the diff and commit it`); }
}

/** viem errors quote the transport URL; the private RPC URL must never reach the console. */
const redact = (text: string) => (process.env.RHC_RPC_URL ? text.split(process.env.RHC_RPC_URL).join("<RHC_RPC_URL>") : text);
main().catch((error) => { console.error(redact(error instanceof Error ? error.message : String(error))); process.exit(1); });
