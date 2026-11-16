import "server-only";
import { dexRegistry } from "./registry-instance";
import { sanitizePublicError } from "@/lib/public-error";

/** Start optional readers together, then require the original Raydium discovery. */
export async function listNativeWalletPositions({ wallet }: { wallet: string }) {
  const tasks = dexRegistry.nativePositionReaders().flatMap(reader => {
    if (!reader.enabled() || !reader.listing) return [];
    const protocol = reader.protocol ?? reader.id;
    return [dexRegistry.listNativePositionRows(reader.id, wallet).then(
      positions => ({ positions, error: null, protocol }),
      (error: unknown) => ({ positions: [], error: sanitizePublicError(error, reader.listing!.unavailableMessage), protocol }),
    )];
  });
  const discovery = await dexRegistry.discoverNativeWallet("raydium-clmm", wallet);
  const additional = await Promise.all(tasks);
  const protocolErrors = additional.flatMap(result => result.error ? [{ protocol: result.protocol, error: result.error }] : []);

  return {
    wallet: discovery.wallet,
    slot: discovery.slot,
    fetchedAt: discovery.fetchedAt,
    positions: [...discovery.positions.map(pos => ({
      positionMint: pos.positionMint,
      positionAccount: pos.positionAccount,
      poolId: pos.poolId,
      mintA: pos.mintA,
      mintB: pos.mintB,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      tickCurrent: pos.tickCurrent,
      rangeSide: pos.rangeSide,
      liquidity: pos.liquidity,
    })), ...additional.flatMap(result => result.positions)],
    ...(protocolErrors.length ? { protocolErrors } : {}),
    assets: discovery.assets.map(asset => ({
      kind: asset.kind,
      mint: asset.mint,
      tokenProgram: asset.tokenProgram,
      decimals: asset.decimals,
      balance: asset.balance,
      totalBalance: asset.totalBalance,
      account: asset.account,
      eligible: asset.eligible,
      reason: asset.reason,
    })),
  };
}

