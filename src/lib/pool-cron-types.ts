/** Type-only compatibility statistics; scan implementation stays inside its DEX module. */
export type PoolCronDiscoveryResult = Awaited<ReturnType<typeof import("./dex/meteora-dlmm/cron.server").publishMeteoraFeed>>;
