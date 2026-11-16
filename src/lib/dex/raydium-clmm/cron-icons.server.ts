import "server-only";
import { resolveTokenIcons } from "@/lib/token-icons/resolve";
import { raydiumPoolSource } from "@/lib/pool-sources/raydium";
import type { CronIconInput } from "../cron-discovery";

export function readRaydiumCronIcons({ mints, fetcher, signal }: CronIconInput) {
  return resolveTokenIcons("solana", mints, raydiumPoolSource.iconSources(fetcher), { signal });
}
