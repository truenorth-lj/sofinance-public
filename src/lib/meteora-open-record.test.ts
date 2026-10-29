import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../packages/engine/src/fixtures/meteora-positions-cbbtc-wbtc.json";
import { decodeMeteoraPosition, meteoraPositionLiquidity } from "@sofinance/engine/protocols/meteora/position";
import { meteoraAddLiquidityByStrategy2Instruction, meteoraInitializePositionInstruction } from "@sofinance/engine/protocols/meteora/open";

vi.mock("server-only", () => ({}));
const logPositionOpenBestEffort = vi.fn();
vi.mock("./opens-log", () => ({ logPositionOpenBestEffort }));
const { recordMeteoraOpen, verifyMeteoraOpen, MeteoraRecordError } = await import("./meteora-open-record");

const accounts = fixture.accounts as Record<string, { owner: string; data: string } | null>;
const POOL = fixture.pool;
const positionId = fixture.positions.find((id) => meteoraPositionLiquidity(decodeMeteoraPosition(Buffer.from(accounts[id]!.data, "base64"))) > 0n)!;
const position = decodeMeteoraPosition(Buffer.from(accounts[positionId]!.data, "base64"));
const wallet = new PublicKey(position.owner);
const SETUP = "5".repeat(87);
const DEPOSIT = "4".repeat(87);
const k = () => Keypair.generate().publicKey;

function txResponse(payer: PublicKey, ix: ReturnType<typeof meteoraInitializePositionInstruction>, err: unknown = null) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: k().toBase58(), instructions: [ix] }).compileToV0Message();
  return { transaction: new VersionedTransaction(message), meta: { err, loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: [], postTokenBalances: [] } };
}

function connection(options: { payer?: PublicKey; firstSignature?: string; owner?: PublicKey } = {}) {
  const payer = options.payer ?? wallet;
  const init = meteoraInitializePositionInstruction({ payer, position: new PublicKey(positionId), lbPair: new PublicKey(POOL), owner: options.owner ?? wallet, lowerBinId: position.lowerBinId, width: position.upperBinId - position.lowerBinId + 1 });
  const add = meteoraAddLiquidityByStrategy2Instruction({
    position: new PublicKey(positionId), lbPair: new PublicKey(POOL), sender: payer, userTokenX: k(), userTokenY: k(), reserveX: k(), reserveY: k(), tokenXMint: k(), tokenYMint: k(),
    tokenXProgram: k(), tokenYProgram: k(), amountX: 1n, amountY: 1n, activeId: 0, maxActiveBinSlippage: 50, minBinId: position.lowerBinId, maxBinId: Math.min(position.upperBinId, position.lowerBinId + 69),
  });
  return {
    getTransaction: vi.fn(async (sig: string) => (sig === SETUP ? txResponse(payer, init) : sig === DEPOSIT ? txResponse(payer, add) : null)),
    getAccountInfo: vi.fn(async () => ({ owner: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"), data: Buffer.from(accounts[positionId]!.data, "base64"), lamports: 1, executable: false })),
    getSignaturesForAddress: vi.fn(async () => [{ signature: DEPOSIT, err: null }, { signature: options.firstSignature ?? SETUP, err: null }]),
  } as unknown as Connection;
}

describe("recordMeteoraOpen", () => {
  it("logs the open once, keyed by the setup (first) signature", async () => {
    const result = await recordMeteoraOpen({ wallet: wallet.toBase58(), setupSignature: SETUP, depositSignature: DEPOSIT, sourceRef: "x" }, connection());
    expect(result).toMatchObject({ recorded: true, txSignature: SETUP, poolAddress: POOL });
    expect(logPositionOpenBestEffort).toHaveBeenCalledWith(expect.objectContaining({ txSignature: SETUP, wallet: wallet.toBase58(), poolAddress: POOL, symbolA: "cbBTC", symbolB: "WBTC" }));
  });

  it("refuses when the fee payer is not the wallet, the setup is not the first signature, or the owner differs", async () => {
    const input = { wallet: wallet.toBase58(), setupSignature: SETUP, depositSignature: DEPOSIT };
    await expect(verifyMeteoraOpen(input, connection({ payer: k() }))).rejects.toBeInstanceOf(MeteoraRecordError);
    await expect(verifyMeteoraOpen(input, connection({ firstSignature: "3".repeat(87) }))).rejects.toThrow(/first transaction/);
    await expect(verifyMeteoraOpen(input, connection({ owner: k() }))).rejects.toThrow(/allowlisted pool/);
    await expect(verifyMeteoraOpen({ ...input, depositSignature: "2".repeat(87) }, connection())).rejects.toThrow(/not confirmed/);
  });
});
