import { isPrimaryCircuitOpen } from "./circuit";
import type { RpcPool, RpcPoolMember } from "./pool";

/**
 * Read-provider selection for `SOLANA_RPC_PROVIDERS` pools: smooth weighted round-robin
 * (nginx style), so new connections are spread across healthy read providers in proportion to
 * their `rps`, instead of always filling the first provider in the list.
 *
 * Every pick, each healthy provider's running score grows by its weight. The highest score is
 * chosen and pays back the total weight. With weights 8 / 12 / 5 that gives an even interleaving
 * (alchemy, helius, solami, alchemy, …), about 32 / 48 / 20 %, never long runs of one provider.
 *
 * Returned order = attempt order for the call:
 *   1. the chosen provider;
 *   2. the other healthy providers, by weight (heaviest first; list order breaks ties). The
 *      connection layer overflows to these, before any request is sent, when (1) has no budget;
 *   3. providers whose circuit is open, in list order, as a last resort.
 *
 * The transaction route never comes here: it stays strictly ordered.
 */

/** A provider without `rps` gets this weight. Set `rps` on every read provider for a fair share. */
export const DEFAULT_READ_WEIGHT = 1;

const scores = new Map<string, number>();

export function readWeight(member: RpcPoolMember): number {
  return member.rps ?? DEFAULT_READ_WEIGHT;
}

export function resetReadRotation(): void {
  scores.clear();
}

/** Whether a pool spreads reads by weight. The legacy pool (no SOLANA_RPC_PROVIDERS) never does. */
export function spreadsReads(pool: RpcPool): boolean {
  return pool.source === "env";
}

/** One smooth weighted round-robin pick among `members`; advances the shared rotation. */
function pick(members: readonly RpcPoolMember[]): RpcPoolMember {
  let total = 0;
  let best: RpcPoolMember | null = null;
  let bestScore = -Infinity;
  for (const member of members) {
    const weight = readWeight(member);
    const score = (scores.get(member.key) ?? 0) + weight;
    scores.set(member.key, score);
    total += weight;
    if (score > bestScore) {
      best = member;
      bestScore = score;
    }
  }
  scores.set(best!.key, bestScore - total);
  return best!;
}

/**
 * Attempt order for a read. `preferredKey` keeps a connection on the provider it was already given
 * (no new pick) while that provider is healthy and supports the method.
 */
export function weightedReadOrder(
  members: readonly RpcPoolMember[],
  options: { preferredKey?: string | null; isOpen?: (key: string) => boolean } = {},
): RpcPoolMember[] {
  const isOpen = options.isOpen ?? isPrimaryCircuitOpen;
  const healthy = members.filter((member) => !isOpen(member.key));
  const open = members.filter((member) => isOpen(member.key));
  if (healthy.length === 0) return [...members];
  const chosen = healthy.find((member) => member.key === options.preferredKey) ?? pick(healthy);
  const rest = healthy
    .filter((member) => member !== chosen)
    .map((member, index) => ({ member, index }))
    .sort((a, b) => readWeight(b.member) - readWeight(a.member) || a.index - b.index)
    .map(({ member }) => member);
  return [chosen, ...rest, ...open];
}
