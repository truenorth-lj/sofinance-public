import { AccountLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./client", () => ({ jupiterQuotePreferCompact: vi.fn(), jupiterSwapInstructions: vi.fn() }));
import { jupiterQuotePreferCompact, jupiterSwapInstructions } from "./client";
import { buildExitSwapLeg } from "./exit";
import { USDC_MINT } from "../ids";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each([true, false])("exit conversion charges output USDC and creates only missing operator ATA=%s", async existing => {
  const owner = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey;
  vi.stubEnv("SOFINANCE_FEE_WALLET", wallet.toBase58()); vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint: new PublicKey(USDC_MINT), owner: wallet, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  const inputAmount = "1000000";
  vi.mocked(jupiterQuotePreferCompact).mockResolvedValue({ inputMint: mint.toBase58(), outputMint: USDC_MINT,
    inAmount: inputAmount, outAmount: "123", otherAmountThreshold: "122", platformFee: { amount: "1", feeBps: 10 }, swapMode: "ExactIn", routePlan: [{}] });
  vi.mocked(jupiterSwapInstructions).mockResolvedValue({ swapInstruction: {}, addressLookupTableAddresses: [] });
  const result = await buildExitSwapLeg({ connection: { getAccountInfo: vi.fn(async () => existing ? { data, owner: TOKEN_PROGRAM_ID } : null) } as never,
    owner, mint, program: TOKEN_PROGRAM_ID, source: Keypair.generate().publicKey, decimals: 6, amount: 1000000n, native: false });
  expect(result.quote.feeAmount).toBe("1");
  expect(result.fee).toHaveLength(existing ? 0 : 1);
  expect(jupiterQuotePreferCompact).toHaveBeenCalledWith(expect.objectContaining({ amount: inputAmount, platformFeeBps: 10 }));
  expect(jupiterSwapInstructions).toHaveBeenCalledWith(expect.objectContaining({ prioritizationFeeLamports: 0, feeAccount: expect.any(String) }), expect.anything());
});
