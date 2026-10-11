import { mintSignToken, type SignKind, type SignPayload } from "./sign-token";
import { buildOpenPositionTx, buildSingleSignerTx, randomAddress } from "./tx";

/** A ready-to-open sign link for `wallet` (the address of the fake wallet) of the given kind. */
export function makeScenario(kind: SignKind, wallet: string, options: {
  payer?: string; expiresInMs?: number; serverSigns?: boolean; secret?: string;
} = {}) {
  const payer = options.payer ?? wallet;
  const built = kind === "open-position" ? buildOpenPositionTx(payer, { serverSigns: options.serverSigns }) : buildSingleSignerTx(payer);
  const poolId = randomAddress();
  const positionMint = randomAddress();
  const permit = "e2e-permit-not-verified-in-this-lane";
  const submitArgs: Record<string, unknown> =
    kind === "add-liquidity"
      ? { permit, wallet, selection: { positionMint, inputMint: randomAddress(), inputKind: "token" }, requested: "1000000",
          floorBps: 9900, expiresAt: Date.now() + 120_000, lastValidBlockHeight: 1, startingLiquidity: "1", expectedLiquidity: "2",
          rangeSide: "inside", startingBalances: { input: "1", a: "1", b: "1" } }
      : kind === "open-position"
        ? { permit, wallet, summary: { operation: "open-position", poolId, nftMint: (built as { nftMint: string }).nftMint } }
        : { permit, wallet, summary: { operation: "compound", positionMint } };
  const payload: SignPayload = {
    kind, wallet, unsignedTransaction: built.b64, permit, submitArgs,
    expiresAt: Date.now() + (options.expiresInMs ?? 120_000),
  };
  return { payload, built, token: mintSignToken(payload, options.secret), submitArgs, poolId, positionMint };
}
