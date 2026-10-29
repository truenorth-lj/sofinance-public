// Golden tests for PR1 of the protocol-adapter refactor: routing Raydium CLMM
// through `protocols/` must not change a single prepared byte or the 10 bps fee.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AddressLookupTableAccount, Keypair, PublicKey, SystemInstruction, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import openOldFixture from "../fixtures/open-size-route.json";
import openCompactFixture from "../fixtures/open-size-compact-route.json";
import compoundFixture from "../fixtures/compound-size-route.json";

vi.mock("server-only", () => ({}));
// Same hermetic seams as open-atomic.test.ts, so the open golden below replays its captured route.
vi.mock("../rpc", async (importOriginal) => ({ ...await importOriginal<typeof import("../rpc")>(), rpcConnection: vi.fn() }));
vi.mock("../open-state", () => ({ readOpenPoolState: vi.fn() }));
vi.mock("../open-quote", () => ({ getOpenPositionQuoteBundle: vi.fn() }));
vi.mock("../open-simulation", () => ({ simulateAndVerifyOpenTransaction: vi.fn() }));
vi.mock("../open-transaction", async importOriginal => ({ ...await importOriginal<object>(), openLookupTableReader: vi.fn() }));
vi.mock("../solami-beam", async importOriginal => ({ ...await importOriginal<object>(), fetchBeamTipAddress: vi.fn(async () => null) }));
vi.mock("@raydium-io/raydium-sdk-v2", async importOriginal => ({ ...await importOriginal<object>(),
  Raydium: { load: vi.fn() }, ClmmInstrument: { ...(await importOriginal<{ ClmmInstrument: object }>()).ClmmInstrument, openPositionFromLiquidityInstructions: vi.fn() },
}));

import { CLMM_PROGRAM_ID, ClmmInstrument, Raydium } from "@raydium-io/raydium-sdk-v2";
import { rpcConnection } from "../rpc";
import { readOpenPoolState } from "../open-state";
import { getOpenPositionQuoteBundle } from "../open-quote";
import { simulateAndVerifyOpenTransaction } from "../open-simulation";
import { openLookupTableReader } from "../open-transaction";
import * as openAtomic from "../open-atomic";
import * as openQuote from "../open-quote";
import * as openRent from "../open-rent";
import * as openState from "../open-state";
import * as compoundAtomic from "../compound-atomic";
import * as lpExit from "../lp-exit-instructions";
import * as selectedState from "../selected-state";
import * as receipt from "../swap/receipt";
import * as walletDiscovery from "../wallet-discovery";
import { DEFAULT_SWAP_FEE_BPS, computeSwapFee, netSwapInput, readSwapFeeConfig, swapFeeTransferInstructions } from "../swap/fee";
import { raydiumClmmAdapter } from "./raydium";
import { getProtocolAdapter, isProtocolId, parseProtocolId, protocolForProgramId } from "./registry";
import { DEFAULT_PROTOCOL, PROTOCOL_IDS } from "./types";

const snapshotEntry = (file: string, name: string) => {
  const source = readFileSync(join(__dirname, "..", "__snapshots__", file), "utf8");
  const match = source.match(new RegExp("exports\\[`" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " 1`\\] = `\"([A-Za-z0-9+/=]+)\"`;"));
  if (!match) throw new Error(`missing snapshot ${name} in ${file}`);
  return match[1]!;
};
type RouteFixture = { instructions: { program: string; data: string; accounts: unknown[][] }[]; tables: { key: string; length: number; entries: unknown[][] }[] };
const decode = (f: RouteFixture) => ({
  ixs: f.instructions.map(ix => new TransactionInstruction({ programId: new PublicKey(ix.program), data: Buffer.from(ix.data, "base64"),
    keys: ix.accounts.map(([address, flags]) => ({ pubkey: new PublicKey(address as string), isSigner: Boolean((flags as number) & 1), isWritable: Boolean((flags as number) & 2) })) })),
  tables: f.tables.map(table => new AddressLookupTableAccount({ key: new PublicKey(table.key), state: {
    deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: Array.from({ length: table.length }, (_, index) => new PublicKey(
      table.entries.find(entry => entry[0] === index)?.[1] as string ?? PublicKey.default.toBase58())),
  } })),
});

describe("protocol registry", () => {
  it("defaults to Raydium CLMM and only knows implemented protocols", () => {
    expect(PROTOCOL_IDS).toEqual(["raydium-clmm"]);
    expect(DEFAULT_PROTOCOL).toBe("raydium-clmm");
    expect(getProtocolAdapter()).toBe(raydiumClmmAdapter);
    expect(getProtocolAdapter("raydium-clmm")).toBe(raydiumClmmAdapter);
    expect(parseProtocolId(undefined)).toBe("raydium-clmm");
    expect(parseProtocolId("")).toBe("raydium-clmm");
    expect(parseProtocolId("raydium-clmm")).toBe("raydium-clmm");
    expect(() => parseProtocolId("orca-whirlpool")).toThrow("Unsupported protocol");
    expect(isProtocolId("meteora-dlmm")).toBe(false);
    expect(protocolForProgramId(CLMM_PROGRAM_ID.toBase58())).toBe(raydiumClmmAdapter);
    expect(protocolForProgramId(SystemProgram.programId.toBase58())).toBeNull();
    expect(Object.isFrozen(raydiumClmmAdapter)).toBe(true);
  });
});

describe("Raydium adapter is the existing builders, unchanged", () => {
  it("every member is the original export (no wrappers, so no behavior change)", () => {
    const a = raydiumClmmAdapter;
    expect(a.programId.equals(CLMM_PROGRAM_ID)).toBe(true);
    expect(a.readOpenPoolState).toBe(openState.readOpenPoolState);
    expect(a.estimateOpenPositionRent).toBe(openRent.estimateOpenPositionRent);
    expect(a.getOpenPositionQuoteBundle).toBe(openQuote.getOpenPositionQuoteBundle);
    expect(a.buildAndSimulateOpenPosition).toBe(openAtomic.buildAndSimulateOpenPosition);
    expect(a.readPositionState).toBe(selectedState.readSelectedPositionState);
    expect(a.buildAndSimulateCompound).toBe(compoundAtomic.buildAndSimulateCompound);
    expect(a.compileCompoundTransaction).toBe(compoundAtomic.compileCompoundTransaction);
    expect(a.buildPositionExitInstructions).toBe(lpExit.buildPositionExitInstructions);
    expect(a.discoverWallet).toBe(walletDiscovery.discoverWallet);
    expect(a.protocolInstructions).toBe(receipt.compoundProtocolInstructions);
  });

  it("the adapter layer never touches the swap fee (fee stays in the shared swap legs)", () => {
    const dir = __dirname;
    for (const file of readdirSync(dir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/from\s+["'][^"']*swap\/(fee|collection|jupiter|leg)["']/);
      expect(source, file).not.toMatch(/process\.env|SOFINANCE_FEE/);
    }
  });
});

describe("10 bps protocol fee is unchanged", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it("defaults to 10 bps whenever a fee wallet is configured", () => {
    expect(DEFAULT_SWAP_FEE_BPS).toBe(10);
    const wallet = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey;
    vi.stubEnv("SOFINANCE_FEE_WALLET", wallet.toBase58()); vi.stubEnv("SOFINANCE_FEE_BPS", undefined);
    expect(readSwapFeeConfig()).toEqual({ wallet, bps: 10 });
    vi.stubEnv("SOFINANCE_FEE_WALLET", undefined);
    expect(readSwapFeeConfig()).toEqual({ wallet: null, bps: 0 });
  });
  it("charges exactly amount * 10 / 10_000 and nets it from the swap input", () => {
    expect(computeSwapFee(1_000_000n, 10)).toBe(1_000n);
    expect(computeSwapFee(30_000_000n, 10)).toBe(30_000n);
    expect(computeSwapFee(9_999n, 10)).toBe(9n);
    expect(netSwapInput(1_000_000n, 10)).toEqual({ feeAmount: 1_000n, swapAmount: 999_000n });
  });
  it("token-input fee is one transferChecked of the fee to the recipient ATA (golden bytes)", () => {
    const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;
    const [ix, ...rest] = swapFeeTransferInstructions({ kind: "token", payer: key(1), owner: key(1), recipient: key(2), amount: computeSwapFee(1_000_000n, 10),
      mint: key(3), source: key(4), decimals: 6, program: TOKEN_PROGRAM_ID });
    expect(rest).toEqual([]);
    expect(ix!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix!.data.toString("hex")).toBe("0ce80300000000000006");
    expect(ix!.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toMatchSnapshot();
  });
});

describe("open: adapter prepares the same transaction as before", () => {
  const old = decode(openOldFixture as RouteFixture), compact = decode(openCompactFixture as RouteFixture);
  const wallet = openCompactFixture.payer, inputMint = "So11111111111111111111111111111111111111112";
  const mintA = compact.ixs[4]!.keys[3]!.pubkey.toBase58(), mintB = compact.ixs[5]!.keys[3]!.pubkey.toBase58();
  const poolId = Keypair.generate().publicKey.toBase58();
  const nftMint = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey.toBase58();
  let strategy = "parallel";
  const state = { wallet, poolId, programId: compact.ixs[8]!.programId.toBase58(), mintA, mintB,
    ataA: compact.ixs[4]!.keys[1]!.pubkey.toBase58(), ataB: compact.ixs[5]!.keys[1]!.pubkey.toBase58(),
    programA: compact.ixs[4]!.keys[5]!.pubkey.toBase58(), programB: compact.ixs[5]!.keys[5]!.pubkey.toBase58(),
    inputMint, inputKind: "native", tickSpacing: 1, solLamports: 1000000000, balances: { a: "0", b: "0", input: "0" } };
  const apiInstruction = (ix: TransactionInstruction) => ({ programId: ix.programId.toBase58(), data: ix.data.toString("base64"),
    accounts: ix.keys.map(key => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })) });

  afterEach(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    vi.stubEnv("SOFINANCE_FEE_WALLET", undefined); vi.stubEnv("SOFINANCE_FEE_BPS", undefined); vi.stubEnv("JUPITER_API_KEY", undefined);
    vi.clearAllMocks(); strategy = "parallel";
    vi.mocked(rpcConnection).mockReturnValue({
      getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({ context: { slot: 1 }, value: keys.map(() => null) })),
      getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(() => null)),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: openOldFixture.blockhash, lastValidBlockHeight: 100 })),
      getFeeForMessage: vi.fn(async () => ({ value: 10000 })),
    } as never);
    vi.mocked(readOpenPoolState).mockResolvedValue({ ...state, fetchedAt: Date.now() } as never);
    vi.mocked(Raydium.load).mockResolvedValue({ clmm: { getPoolInfoFromRpc: vi.fn(async () => ({
      poolInfo: { programId: state.programId, mintA: { address: mintA }, mintB: { address: mintB }, config: { tickSpacing: 1 } }, poolKeys: {},
    })) }, api: { fetchPoolKeysById: vi.fn(async () => []) } } as never);
    vi.mocked(openLookupTableReader).mockImplementation(() => async keys => {
      const tables = strategy === "sequential" ? compact.tables : old.tables;
      return keys.map(key => tables.find(table => table.key.equals(key))!);
    });
    vi.mocked(ClmmInstrument.openPositionFromLiquidityInstructions).mockImplementation(async () => ({
      instructions: [strategy === "sequential" ? compact.ixs[8]! : old.ixs[17]!], lookupTableAddress: [], signers: [],
    } as never));
    vi.mocked(getOpenPositionQuoteBundle).mockImplementation(async (_w, _s, _a, _r, _f, _t, _b, _snap, mode) => {
      strategy = mode === "parallel" ? "parallel" : "sequential";
      const sequential = mode !== "parallel";
      const primaryMint = mode === "sequential-b" ? mintB : mintA;
      const secondaryMint = mode === "sequential-b" ? mintA : mintB;
      const captured = sequential ? compact : old;
      const route = (ix: TransactionInstruction, input: string, output: string, spend: bigint, minOut: bigint, setup: TransactionInstruction[] = []) => ({
        inputMint: input, outputMint: output, spend, minOut,
        route: { inputMint: input, outputMint: output, inAmount: spend.toString(), otherAmountThreshold: "3000000",
          setupInstructions: setup.map(apiInstruction), swapInstruction: apiInstruction(ix), cleanupInstruction: null, otherInstructions: [],
          addressesByLookupTableAddress: Object.fromEntries(captured.tables.map(table => [table.key.toBase58(), table.state.addresses.map(key => key.toBase58())])),
        },
      });
      return { state, quote: { expiresAt: Date.now() + 75000, requested: "30000000", rangeSide: "inside", tickLower: -60, tickUpper: 60,
        liquidity: "10000", amountMaxA: "10000", amountMaxB: "10000", passesFloor: true, warning: "",
        rent: { refundableLamports: "0", nonRefundableLamports: "0" } },
        legs: sequential
          ? [route(compact.ixs[6]!, inputMint, primaryMint, 30000000n, 1500000n), route(compact.ixs[7]!, primaryMint, secondaryMint, 1500000n, 10000n)]
          : [route(old.ixs[6]!, inputMint, mintA, 15000000n, 10000n, old.ixs.slice(4, 6)), route(old.ixs[13]!, inputMint, mintB, 15000000n, 10000n, old.ixs.slice(11, 13))],
      } as never;
    });
    vi.mocked(simulateAndVerifyOpenTransaction).mockResolvedValue({ endingLiquidity: "10000", spentInput: null, dustA: "0", dustB: "0",
      solDebitLamports: "30010000", positionAccount: poolId, nftAta: poolId, unitsConsumed: 350000 });
  });

  it("matches the committed open-atomic golden packet byte-for-byte", async () => {
    const args = [wallet, { poolId, inputMint, inputKind: "native" }, "0.03", { preset: "standard" }, 9900, 100, { nftMint }] as const;
    const viaAdapter = await getProtocolAdapter().buildAndSimulateOpenPosition(...args);
    const direct = await openAtomic.buildAndSimulateOpenPosition(...args);
    const bytes = Buffer.from(viaAdapter.transaction.serialize());
    expect(bytes.equals(Buffer.from(direct.transaction.serialize()))).toBe(true);
    expect(bytes.toString("base64")).toBe(snapshotEntry("open-atomic.test.ts.snap", "prepares the compact captured sequential transaction first"));
    expect(viaAdapter.summary.nftMint).toBe(nftMint);
  });
});

describe("add / compound / exit instruction lists are unchanged", () => {
  it("compound: compiles the committed compound-size golden packet", () => {
    const original = decode(compoundFixture as RouteFixture).ixs;
    const tables = decode(compoundFixture as RouteFixture).tables;
    const payer = new PublicKey(compoundFixture.payer);
    const compile = (instructions: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({
      payerKey: payer, recentBlockhash: compoundFixture.blockhash, instructions }).compileToV0Message(tables));
    const compact: TransactionInstruction[] = [];
    for (let index = 0; index < original.length; index++) {
      const ix = original[index]!;
      if (!ix.programId.equals(SystemProgram.programId)) { compact.push(ix); continue; }
      const creation = SystemInstruction.decodeCreateWithSeed(ix);
      const initialize = original[++index]!;
      compact.push(...compoundAtomic.createCompoundAccountInstructions(payer, { seed: creation.seed, address: creation.newAccountPubkey.toBase58(),
        mint: initialize.keys[1]!.pubkey.toBase58(), program: creation.programId.toBase58(), rentLamports: Number(creation.lamports), space: Number(creation.space) }));
    }
    const viaAdapter = compile(compact);
    compoundAtomic.assertCompoundTransactionSize(viaAdapter);
    expect(Buffer.from(viaAdapter.serialize()).toString("base64")).toBe(snapshotEntry("compound-size.test.ts.snap",
      "atomic compound packet limit > reproduces the 1268-byte rejected packet and fits both isolated account initializations without changing financial instructions"));
    // The adapter's compiler (budget handling) is the original and yields the same financial instruction list.
    const compiled = raydiumClmmAdapter.compileCompoundTransaction(compile, compact.slice(1));
    expect(Buffer.from(compiled.serialize()).equals(Buffer.from(compoundAtomic.compileCompoundTransaction(compile, compact.slice(1)).serialize()))).toBe(true);
    expect(compiled.message.compiledInstructions.map(ix => compiled.message.staticAccountKeys[ix.programIdIndex]!.toBase58())).toMatchSnapshot();
  });
});
