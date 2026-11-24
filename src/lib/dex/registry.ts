import type { ReadCronTokenIcons, InspectCronPools, CronIconInput } from "./cron-discovery";
import type { NativePoolCron, PoolCronPolicy, PoolCronDiscoveryInput, PoolCronLaneInput } from "./pool-cron";
import type { PoolDailyAprResult } from "@/lib/pool-daily-apr";
import type { PoolSource } from "@/lib/pool-sources/types";
import type { Lease, RwaStore } from "@/lib/rwa-store-types";
import type { Connection } from "@solana/web3.js";
import type { PortfolioInput, PortfolioReader } from "@/lib/portfolio/model";
import { positionFigures } from "@/lib/portfolio/figures";
import { portfolioAbortable, PORTFOLIO_POSITION_DEADLINE_MS } from "./portfolio-workers";
import type { PositionKey, UnifiedPosition } from "@/lib/unified-positions/model";
import type { PublicPoolReads, PublicPoolReadPolicy } from "./public-pool-read";
import type { LpPlanReads } from "./lp-plan-read";
import type { NativeAprRefresh, NativeAprRunInput } from "./apr-refresh";
import type { DexAdapter } from "./adapter";
import type { NativeEvmPositionReads, EvmPositionReadPolicy } from "./evm-position-read";
import type { NativeEvmLiquidity } from "./evm-liquidity";
import type { BuildAdd } from "./add-prepare";
import type { ValidateSignedAdd } from "./add-submit";
import type { QuoteAdd, ReadAddState } from "./selected-read";
import type { NativePositionReader, RegisteredPositionReader } from "./position-read";
import type { DiscoverNativeWallet, NativeWalletListing } from "./wallet-read";
import type { BuildWithdrawal } from "./withdraw-prepare";
import type { ReadWithdrawalStatus } from "./withdraw-status";
import type { BuildCompound, BuildCompoundRecovery } from "./compound-prepare";
import type { ReadCompoundState, ConfirmCompound, ImportCompoundReceipt } from "./compound-read";
import type { BuildOpen, QuoteOpen } from "./open-prepare";
import type { BuildSolSwapStep, ReadSolSwapDelivery } from "./sol-swap-step";
import { DexUnsupportedError } from "./errors";
import { feePolicyProblems } from "./fees";
import { normalizeDexId, type DexCapabilities, type DexDescriptor, type DexId } from "./types";

/** One DEX as registered server-side: its descriptor, a lazy adapter (keeps SDKs out of other routes), its pool scan. */
export type DexModule = {
  descriptor: DexDescriptor;
  nativeAprRefresh?: NativeAprRefresh;
  poolCron?: NativePoolCron;
  readCronTokenIcons?: ReadCronTokenIcons;
  inspectCronPools?: InspectCronPools;
  lpPlanReads?: LpPlanReads;
  publicPoolReads?: PublicPoolReads;
  /** Existing native EVM validation/builds; independent of generic HTTP capabilities. */
  evmLiquidity?: NativeEvmLiquidity;
  evmPositionReads?: NativeEvmPositionReads;
  /** Legacy native position-read policy; distinct from generic adapter/HTTP capabilities. */
  positionReads?: NativePositionReader;
  discoverWallet?: DiscoverNativeWallet;
  adapter?: () => Promise<DexAdapter>;
  /** Full add simulation for existing transports; independent of generic HTTP rollout. */
  buildAdd?: BuildAdd;
  /** Checks an already-signed native add; independent of new-operation rollout. */
  validateSignedAdd?: ValidateSignedAdd;
  /** Existing native quote/state DTOs; independent of the generic adapter's read contracts. */
  quoteAdd?: QuoteAdd;
  readAddState?: ReadAddState;
  /** Existing withdrawal transports, including signed recovery; independent of generic HTTP rollout. */
  buildWithdrawal?: BuildWithdrawal;
  readWithdrawalStatus?: ReadWithdrawalStatus;
  buildCompound?: BuildCompound;
  buildCompoundRecovery?: BuildCompoundRecovery;
  /** Readback and historical recovery stay available independently of new compound preparation. */
  readCompoundState?: ReadCompoundState;
  confirmCompound?: ConfirmCompound;
  importCompoundReceipt?: ImportCompoundReceipt;
  buildOpen?: BuildOpen;
  quoteOpen?: QuoteOpen;
  buildSolSwapStep?: BuildSolSwapStep;
  readSolSwapDelivery?: ReadSolSwapDelivery;
  /** Compact Portfolio reader; a dedicated binding does not enable generic trading routes. */
  preparePortfolio?: (input: PortfolioInput, signal: AbortSignal, accounts?: Connection) => Promise<PortfolioReader>;
  /**
   * Generic Portfolio reader only: warms the request's shared account batch (`accounts`) with every account its
   * position reads will need, so all positions share a few getMultipleAccounts waves. Best effort; lazy like the adapter.
   */
  prefetchPortfolioAccounts?: (nativeIds: readonly string[], accounts: Connection) => Promise<void>;
  /** Independent of generic HTTP enablement; load only when the cron requests a source. */
  poolSource?: { order: number; load: () => Promise<PoolSource> };
  /**
   * Daily fee APR series for one of this DEX's pools (same shape as the Raydium series of /api/pool-daily-apr), or
   * null when the pool is not this DEX's. Lazy, like the adapter.
   */
  poolDailyApr?: (poolId: string) => Promise<PoolDailyAprResult | null>;
  /**
   * Saves today's (UTC) TVL for this DEX's listed pools, for DEXes whose upstream keeps no TVL history. Called by the APR
   * refresh (cron); must be idempotent within a UTC day (a saved day is never overwritten). Lazy, like the adapter.
   */
  recordDailyTvl?: (input: DailyTvlRecordInput) => Promise<DailyTvlRecord>;
  /**
   * When provided and it returns false, the generic `/api/dex/[dex]/[op]` route 404s without loading the adapter
   * (no I/O). Omitted = the module is served (Meteora and any current module stay unchanged). The hook is data on the
   * module: the route never names a DEX id.
   */
  enabled?: (op: string) => boolean;
  /**
   * When provided and it returns true, the generic `/api/dex/[dex]/[op]` route answers 429 with Retry-After 60
   * without loading the adapter (no I/O). Omitted = the route does not apply this extra limit. The hook is data
   * on the module: the route never names a DEX id.
   */
  rateLimited?: (op: string, request: Request) => boolean;
};

/** What the APR refresh hands a DEX's daily TVL record: the store under the job's lease, and the job's fetch/clock/abort. */
export type DailyTvlRecordInput = {
  store: RwaStore; lease: Lease; fetcher: typeof fetch; clock: () => number; signal: AbortSignal;
};
export type DailyTvlStats = {
  date: string; pools: number; alreadySaved: number; saved: number; failed: number;
  /** Set when the upstream rate-limited the run and it stopped early (the rest are retried next run). */
  stoppedBy?: "429";
  /** Saved rows whose source TVL leaves out the multiplier but could not be corrected (kept as published; X3-7). */
  scaledUiUnverified?: number;
};
export type DailyTvlRecord = { stats: DailyTvlStats; issues: string[] };

/** Client-safe lookups over descriptors only. */
export type DexDescriptorRegistry = {
  readonly descriptors: readonly DexDescriptor[];
  /** Accepts canonical ids and one-release legacy aliases. */
  descriptorFor(id: string): DexDescriptor | null;
  /** Merged capabilities for a position: its DEX's, with that position's overrides on top; null for an unknown DEX. */
  capabilitiesFor(position: UnifiedPosition): DexCapabilities | null;
};

export type DexRegistry = DexDescriptorRegistry & {
  readCronTokenIcons(id: string, input: CronIconInput): ReturnType<ReadCronTokenIcons>;
  inspectCronPools(id: string, ...args: Parameters<InspectCronPools>): ReturnType<InspectCronPools>;
  poolCronPolicyFor(id: string): PoolCronPolicy;
  publishPoolCron(id: string, input: PoolCronDiscoveryInput): ReturnType<NativePoolCron["publish"]>;
  refreshPoolCron(id: string, input: PoolCronLaneInput): ReturnType<NativePoolCron["refresh"]>;
  prepareNativeAprRun(id: string, input: NativeAprRunInput): Promise<Awaited<ReturnType<NativeAprRefresh["prepare"]>> | null>;
  readLpObservations(id: string, ...args: Parameters<LpPlanReads["observations"]>): ReturnType<LpPlanReads["observations"]>;
  readLpExitPreview(id: string, ...args: Parameters<LpPlanReads["exitPreview"]>): ReturnType<LpPlanReads["exitPreview"]>;
  protocolPoolReadPolicyFor(id: string): PublicPoolReadPolicy | null;
  readProtocolPools(id: string): Promise<Awaited<ReturnType<PublicPoolReads["discovery"]["read"]>> | null>;
  readProtocolRangeApr(id: string, poolId: string): ReturnType<PublicPoolReads["rangeApr"]["read"]>;
  evmPositionReadPolicyFor(id: string): EvmPositionReadPolicy;
  readEvmPositions(id: string, wallet: `0x${string}`, options?: { fresh?: boolean }): ReturnType<NativeEvmPositionReads["scan"]>;
  readEvmPositionValues(id: string, ids: bigint[]): ReturnType<NativeEvmPositionReads["values"]>;
  evmLiquiditySchemasFor(id: string): NativeEvmLiquidity["schemas"];
  runEvmOpen(id: string, command: Parameters<NativeEvmLiquidity["open"]>[0]): ReturnType<NativeEvmLiquidity["open"]>;
  runEvmExit(id: string, command: Parameters<NativeEvmLiquidity["exit"]>[0]): ReturnType<NativeEvmLiquidity["exit"]>;
  adapterFor(id: string): Promise<DexAdapter | null>;
  nativePositionReaders(): readonly RegisteredPositionReader[];
  discoverNativeWallet(id: string, ...args: Parameters<DiscoverNativeWallet>): ReturnType<DiscoverNativeWallet>;
  listNativePositionRows(id: string, ...args: Parameters<NativeWalletListing["read"]>): ReturnType<NativeWalletListing["read"]>;
  readPositionPerformance(id: string, ...args: Parameters<NativePositionReader["performance"]>): ReturnType<NativePositionReader["performance"]>;
  readPositionRange(id: string, ...args: Parameters<NativePositionReader["range"]>): ReturnType<NativePositionReader["range"]>;
  buildAdd(id: string, ...args: Parameters<BuildAdd>): ReturnType<BuildAdd>;
  validateSignedAdd(id: string, ...args: Parameters<ValidateSignedAdd>): ReturnType<ValidateSignedAdd>;
  quoteAdd(id: string, ...args: Parameters<QuoteAdd>): ReturnType<QuoteAdd>;
  readAddState(id: string, ...args: Parameters<ReadAddState>): ReturnType<ReadAddState>;
  buildWithdrawal(id: string, ...args: Parameters<BuildWithdrawal>): ReturnType<BuildWithdrawal>;
  readWithdrawalStatus(id: string, ...args: Parameters<ReadWithdrawalStatus>): ReturnType<ReadWithdrawalStatus>;
  buildCompound(id: string, ...args: Parameters<BuildCompound>): ReturnType<BuildCompound>;
  buildCompoundRecovery(id: string, ...args: Parameters<BuildCompoundRecovery>): ReturnType<BuildCompoundRecovery>;
  readCompoundState(id: string, ...args: Parameters<ReadCompoundState>): ReturnType<ReadCompoundState>;
  confirmCompound(id: string, ...args: Parameters<ConfirmCompound>): ReturnType<ConfirmCompound>;
  importCompoundReceipt(id: string, ...args: Parameters<ImportCompoundReceipt>): ReturnType<ImportCompoundReceipt>;
  buildOpen(id: string, ...args: Parameters<BuildOpen>): ReturnType<BuildOpen>;
  quoteOpen(id: string, ...args: Parameters<QuoteOpen>): ReturnType<QuoteOpen>;
  buildSolSwapStep(id: string, ...args: Parameters<BuildSolSwapStep>): ReturnType<BuildSolSwapStep>;
  readSolSwapDelivery(id: string, ...args: Parameters<ReadSolSwapDelivery>): ReturnType<ReadSolSwapDelivery>;
  preparePortfolio(id: string, input: PortfolioInput, signal: AbortSignal, accounts?: Connection): Promise<PortfolioReader | null>;
  /**
   * True only when this id is a registered module whose `enabled(op)` hook returned false.
   * Unknown ids and modules with no hook are not disabled, so the route can still resolve a
   * missing adapter (or a test double) the same way as before. The generic route 404s when
   * this is true, without calling `adapterFor`.
   */
  isDisabled(id: string, op: string): boolean;
  /**
   * True only when this id is a registered module whose `rateLimited(op, request)` hook returned true.
   * The generic route 429s when this is true, without calling `adapterFor`.
   */
  isRateLimited(id: string, op: string, request: Request): boolean;
  poolSources(): Promise<readonly PoolSource[]>;
  poolSourceFor(id: string): Promise<PoolSource | null>;
  /**
   * The daily fee APR series from the registered DEX that lists this pool; null when none does (the caller keeps its
   * existing Raydium path for those pools).
   */
  poolDailyApr(poolId: string): Promise<PoolDailyAprResult | null>;
  /**
   * Runs every registered DEX's daily TVL record. A DEX that throws is listed in `failures` (raw error: the caller
   * sanitizes it for its own output); the others still run. Never throws.
   */
  recordDailyTvl(input: DailyTvlRecordInput): Promise<{
    stats: Partial<Record<DexId, DailyTvlStats>>; issues: string[]; failures: { dex: DexId; displayName: string; error: unknown }[];
  }>;
};

/** Problems with a set of descriptors (duplicate ids, an invalid fee policy, impossible open-step bounds). */
export function dexDescriptorProblems(descriptors: readonly DexDescriptor[]): string[] {
  const problems: string[] = [];
  const seen = new Set<DexId>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) problems.push(`${descriptor.id}: registered twice`);
    seen.add(descriptor.id);
    for (const problem of feePolicyProblems(descriptor.meta.feePolicy)) problems.push(`${descriptor.id}: ${problem}`);
    const { min, max } = descriptor.meta.openSteps;
    if (!(Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min)) problems.push(`${descriptor.id}: openSteps must be 1 <= min <= max`);
  }
  return problems;
}

function dexModuleProblems(modules: readonly DexModule[]): string[] {
  const problems = dexDescriptorProblems(modules.map((entry) => entry.descriptor));
  for (const { descriptor, poolSource } of modules) {
    if (poolSource && !Number.isFinite(poolSource.order)) problems.push(`${descriptor.id}: pool source order must be finite`);
  }
  return problems;
}

export function createDexDescriptorRegistry(descriptors: readonly DexDescriptor[]): DexDescriptorRegistry {
  const problems = dexDescriptorProblems(descriptors);
  if (problems.length) throw new Error(`Invalid DEX registry: ${problems.join("; ")}`);
  const byId = new Map<DexId, DexDescriptor>(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const descriptorFor = (id: string) => {
    const canonical = normalizeDexId(id);
    return canonical ? byId.get(canonical) ?? null : null;
  };
  return Object.freeze({
    descriptors: Object.freeze([...descriptors]),
    descriptorFor,
    capabilitiesFor(position: UnifiedPosition) {
      const descriptor = descriptorFor(position.source);
      if (!descriptor) return null;
      const override = descriptor.positionCapabilities?.(position);
      return override && Object.keys(override).length ? { ...descriptor.capabilities, ...override } : descriptor.capabilities;
    },
  });
}

/** Resolve from the generic descriptor when no separate native contract is declared. */
function nativePositionCapabilities(entry: DexModule) {
  return entry.descriptor.nativeCapabilities?.positions ?? entry.descriptor.capabilities;
}
function nativeOpenCapability(entry: DexModule) {
  return entry.descriptor.nativeCapabilities?.open ?? entry.descriptor.capabilities.open;
}

export function createDexRegistry(modules: readonly DexModule[]): DexRegistry {
  const problems = dexModuleProblems(modules);
  if (problems.length) throw new Error(`Invalid DEX registry: ${problems.join("; ")}`);
  const lookups = createDexDescriptorRegistry(modules.map((entry) => entry.descriptor));
  const byId = new Map<DexId, DexModule>(modules.map((entry) => [entry.descriptor.id, entry]));
  const sources = modules.filter(entry => entry.poolSource).sort((a, b) => a.poolSource!.order - b.poolSource!.order);
  const loadPoolSource = async (entry: DexModule): Promise<PoolSource> => {
    const source = await entry.poolSource!.load();
    if (source.id !== entry.descriptor.id) throw new Error(`${entry.descriptor.id}: pool source "${source.id}" has a different id`);
    return source;
  };
  const positionReaders = Object.freeze(modules.flatMap(entry => entry.positionReads
    ? [Object.freeze({ ...entry.positionReads, id: entry.descriptor.id })] : []).sort((a, b) => a.order - b.order));
  return Object.freeze({
    ...lookups,
    async readCronTokenIcons(id: string, input: CronIconInput) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.readCronTokenIcons : undefined;
      if (!binding) throw new DexUnsupportedError();
      return binding({ ...input, mints: [...input.mints] });
    },
    async inspectCronPools(id: string, ...args: Parameters<InspectCronPools>) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.inspectCronPools : undefined;
      if (!binding) throw new DexUnsupportedError();
      return binding(...args);
    },
    poolCronPolicyFor(id: string) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.poolCron : undefined;
      if (!binding) throw new DexUnsupportedError();
      return { ...binding.policy };
    },
    async publishPoolCron(id: string, input: PoolCronDiscoveryInput) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.poolCron : undefined;
      if (!binding) throw new DexUnsupportedError();
      // Capture initiating lease authority and seed mints before the module's lazy import.
      return binding.publish({ ...input, lease: { ...input.lease }, seedPairs: input.seedPairs.map(pair => ({ ...pair })) });
    },
    async refreshPoolCron(id: string, input: PoolCronLaneInput) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.poolCron : undefined;
      if (!binding) throw new DexUnsupportedError();
      return binding.refresh({ ...input, lease: { ...input.lease } });
    },
    async prepareNativeAprRun(id: string, input: NativeAprRunInput) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.nativeAprRefresh : undefined;
      if (!binding?.enabled()) return null;
      // Capture lease authority before lazy loading; keep store, client, clock, signal and shared gate live.
      return binding.prepare({ ...input, lease: { ...input.lease } });
    },
    async readLpObservations(id: string, ...args: Parameters<LpPlanReads["observations"]>) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.lpPlanReads : undefined;
      // These are evidence reads, independent of new-operation/generic plan capabilities.
      if (!binding) throw new DexUnsupportedError();
      const [command, ...context] = args;
      return binding.observations(structuredClone(command), ...context);
    },
    async readLpExitPreview(id: string, ...args: Parameters<LpPlanReads["exitPreview"]>) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.lpPlanReads : undefined;
      if (!binding) throw new DexUnsupportedError();
      // Primitive terms are captured at entry; live fetch/cancellation objects retain their identity.
      return binding.exitPreview(...args);
    },
    protocolPoolReadPolicyFor(id: string) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.publicPoolReads : undefined;
      return binding ? { snapshotBacked: binding.snapshotBacked, rangeAprUnavailableMessage: binding.rangeAprUnavailableMessage } : null;
    },
    async readProtocolPools(id: string) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.publicPoolReads : undefined;
      if (!binding?.discovery.enabled()) return null;
      return binding.discovery.read();
    },
    async readProtocolRangeApr(id: string, poolId: string) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.publicPoolReads : undefined;
      if (!binding?.rangeApr.enabled()) return null;
      return binding.rangeApr.read(poolId);
    },
    async adapterFor(id: string) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      return entry?.adapter ? entry.adapter() : null;
    },
    evmPositionReadPolicyFor(id: string) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.evmPositionReads : undefined;
      if (!binding) throw new DexUnsupportedError();
      return { parseIds: binding.parseIds, scanFailedMessage: binding.scanFailedMessage };
    },
    async readEvmPositions(id: string, wallet: `0x${string}`, options: { fresh?: boolean } = {}) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.evmPositionReads : undefined;
      if (!binding?.enabled()) throw new DexUnsupportedError();
      return binding.scan(wallet, { ...options });
    },
    async readEvmPositionValues(id: string, ids: bigint[]) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.evmPositionReads : undefined;
      if (!binding?.enabled()) throw new DexUnsupportedError();
      return binding.values([...ids]);
    },
    evmLiquiditySchemasFor(id: string) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.evmLiquidity : undefined;
      if (!binding) throw new DexUnsupportedError();
      return binding.schemas;
    },
    async runEvmOpen(id: string, command: Parameters<NativeEvmLiquidity["open"]>[0]) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.evmLiquidity : undefined;
      if (!binding?.enabled()) throw new DexUnsupportedError();
      // Retain the initiating wallet, amount, range and signed Permit2 terms across lazy loading.
      return binding.open(structuredClone(command));
    },
    async runEvmExit(id: string, command: Parameters<NativeEvmLiquidity["exit"]>[0]) {
      const canonical = normalizeDexId(id);
      const binding = canonical ? byId.get(canonical)?.evmLiquidity : undefined;
      if (!binding?.enabled()) throw new DexUnsupportedError();
      return binding.exit(structuredClone(command));
    },
    nativePositionReaders: () => positionReaders,
    async discoverNativeWallet(id: string, ...args: Parameters<DiscoverNativeWallet>) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      // Account discovery remains available independently of new-operation rollout.
      if (!entry?.discoverWallet) throw new DexUnsupportedError();
      return entry.discoverWallet(...args);
    },
    async listNativePositionRows(id: string, wallet: string) {
      const canonical = normalizeDexId(id);
      const reader = canonical ? byId.get(canonical)?.positionReads : undefined;
      if (!reader?.enabled() || !reader.listing) throw new DexUnsupportedError();
      return reader.listing.read(wallet);
    },
    async readPositionPerformance(id: string, positionMint: string, options: Parameters<NativePositionReader["performance"]>[1]) {
      const canonical = normalizeDexId(id);
      const reader = canonical ? byId.get(canonical)?.positionReads : undefined;
      if (!reader?.enabled()) throw new DexUnsupportedError();
      // Snapshot terms without cloning live cancellation, connection or provider objects.
      const input = { ...options, ...(options.historyAfterSignatures ? { historyAfterSignatures: [...options.historyAfterSignatures] } : {}) };
      return reader.performance(positionMint, input);
    },
    async readPositionRange(id: string, positionMint: string) {
      const canonical = normalizeDexId(id);
      const reader = canonical ? byId.get(canonical)?.positionReads : undefined;
      if (!reader?.enabled()) throw new DexUnsupportedError();
      return reader.range(positionMint);
    },
    async buildAdd(id: string, ...args: Parameters<BuildAdd>) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      if (!entry || !nativePositionCapabilities(entry).deposit.supported || !entry.buildAdd) throw new DexUnsupportedError();
      const [command, options] = args;
      // A module may lazy-load before reading these values; retain the initiating preview/build terms.
      return entry.buildAdd({ ...command, selection: { ...command.selection } }, options ? { ...options } : undefined);
    },
    async validateSignedAdd(id: string, command: Parameters<ValidateSignedAdd>[0],
      connection: Parameters<ValidateSignedAdd>[1], profile: Parameters<ValidateSignedAdd>[2]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      // Existing signed operations still require full validation when new deposits are disabled.
      // This binding is not an authorization bypass: the trusted caller verifies the permit/message first.
      if (!entry?.validateSignedAdd) throw new DexUnsupportedError();
      return entry.validateSignedAdd({ ...command, permitInput: structuredClone(command.permitInput) }, connection, profile);
    },
    async quoteAdd(id: string, command: Parameters<QuoteAdd>[0], context?: Parameters<QuoteAdd>[1]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      if (!entry || !nativePositionCapabilities(entry).deposit.supported || !entry.quoteAdd) throw new DexUnsupportedError();
      // Keep request identity stable while retaining the shared signal, budget and connection.
      const input = { ...command, selection: { ...command.selection } };
      const scope = context ? { ...context } : undefined;
      scope?.signal.throwIfAborted();
      const quote = await entry.quoteAdd(input, scope);
      scope?.signal.throwIfAborted();
      return quote;
    },
    async readAddState(id: string, command: Parameters<ReadAddState>[0]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      // State remains readable for diagnostics and recovery when new deposits are unavailable.
      if (!entry?.readAddState) throw new DexUnsupportedError();
      return entry.readAddState({ ...command, selection: { ...command.selection } });
    },
    async readWithdrawalStatus(id: string, command: Parameters<ReadWithdrawalStatus>[0]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      // Pending withdrawals must remain reconcilable when new preparation is disabled.
      if (!entry?.readWithdrawalStatus) throw new DexUnsupportedError();
      return entry.readWithdrawalStatus(structuredClone(command));
    },
    async buildWithdrawal(id: string, input: Parameters<BuildWithdrawal>[0], preview?: boolean) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      // Native capabilities describe these compatibility contracts; generic capabilities
      // describe DexAdapter/StepResult. Neither record enables generic HTTP routes.
      if (!entry?.buildWithdrawal) throw new DexUnsupportedError();
      const command = structuredClone(input);
      // Stage 2 converts an already-landed withdrawal. The engine still requires
      // the signed first-stage permit and a matching finalized receipt; the stage
      // label alone cannot authorize it or remove any more liquidity.
      if (!nativePositionCapabilities(entry).withdraw.supported && command?.stage !== "swap") throw new DexUnsupportedError();
      return entry.buildWithdrawal(command, preview);
    },
    async buildCompound(id: string, command: Parameters<BuildCompound>[0]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      if (!entry || !nativePositionCapabilities(entry).compound.supported
        || !entry.buildCompound) throw new DexUnsupportedError();
      return entry.buildCompound(structuredClone(command));
    },
    async buildCompoundRecovery(id: string, command: Parameters<BuildCompoundRecovery>[0]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      // Recovery must remain usable when new compounding is disabled.
      if (!entry?.buildCompoundRecovery) throw new DexUnsupportedError();
      return entry.buildCompoundRecovery(structuredClone(command));
    },
    async readCompoundState(id: string, command: Parameters<ReadCompoundState>[0], connection: Parameters<ReadCompoundState>[1]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      if (!entry?.readCompoundState) throw new DexUnsupportedError();
      return entry.readCompoundState({ ...command }, connection);
    },
    async confirmCompound(id: string, command: Parameters<ConfirmCompound>[0], connection: Parameters<ConfirmCompound>[1]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      if (!entry?.confirmCompound) throw new DexUnsupportedError();
      return entry.confirmCompound(structuredClone(command), connection);
    },
    async importCompoundReceipt(id: string, command: Parameters<ImportCompoundReceipt>[0], connection: Parameters<ImportCompoundReceipt>[1]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      if (!entry?.importCompoundReceipt) throw new DexUnsupportedError();
      return entry.importCompoundReceipt({ ...command }, connection);
    },
    async buildOpen(id: string, command: Parameters<BuildOpen>[0], options?: Parameters<BuildOpen>[1]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      if (!entry || !nativeOpenCapability(entry).supported || !entry.buildOpen) throw new DexUnsupportedError();
      return entry.buildOpen(structuredClone(command), options ? { ...options } : undefined);
    },
    async quoteOpen(id: string, command: Parameters<QuoteOpen>[0], profile: Parameters<QuoteOpen>[1]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      if (!entry || !nativeOpenCapability(entry).supported || !entry.quoteOpen) throw new DexUnsupportedError();
      return entry.quoteOpen(structuredClone(command), profile);
    },
    async buildSolSwapStep(id: string, command: Parameters<BuildSolSwapStep>[0]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      if (!entry || !nativeOpenCapability(entry).supported || !entry.buildSolSwapStep) throw new DexUnsupportedError();
      return entry.buildSolSwapStep({ ...command });
    },
    async readSolSwapDelivery(id: string, command: Parameters<ReadSolSwapDelivery>[0]) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      // Receipt reconciliation is readback, independent of whether new opens are available.
      if (!entry?.readSolSwapDelivery) throw new DexUnsupportedError();
      return entry.readSolSwapDelivery({ ...command });
    },
    async preparePortfolio(id: string, input: PortfolioInput, signal: AbortSignal, accounts?: Connection): Promise<PortfolioReader | null> {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      if (!entry) return null;
      if (entry.preparePortfolio) return entry.preparePortfolio(input, signal, accounts);
      const { capabilities, ui } = entry.descriptor;
      if (capabilities.signer !== "solana-wallet" || ui?.listPositions === false || !capabilities.performance.supported
        || (entry.enabled && !entry.enabled("performance"))) return null;
      const adapter = await entry.adapter?.();
      if (!adapter) return null;
      if (accounts && entry.prefetchPortfolioAccounts) {
        // Best effort: a failed or slow warm-up leaves each row to read (and retry) its own accounts.
        const ids = input.positions.map((position) => position.key.slice(position.key.indexOf(":") + 1));
        await portfolioAbortable(entry.prefetchPortfolioAccounts(ids, accounts),
          AbortSignal.any([signal, AbortSignal.timeout(PORTFOLIO_POSITION_DEADLINE_MS)])).catch(() => {});
      }
      return async (position, readSignal) => {
        const result = await adapter.performance(position.key as PositionKey, { signal: readSignal, ...(accounts ? { accountReads: accounts } : {}) });
        const figures = positionFigures(result.report);
        if (result.partial) figures.cumulativeFeesUsd = null;
        return { figures, evaluatedAt: result.report?.evaluatedAtIso ?? null, historyComplete: !result.partial,
          historyRefreshResolved: false };
      };
    },
    isDisabled(id: string, op: string) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      return Boolean(entry?.enabled && !entry.enabled(op));
    },
    isRateLimited(id: string, op: string, request: Request) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      return Boolean(entry?.rateLimited?.(op, request));
    },
    poolSources: async () => Object.freeze(await Promise.all(sources.map(loadPoolSource))),
    poolSourceFor: async id => {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      return entry?.poolSource ? loadPoolSource(entry) : null;
    },
    async poolDailyApr(poolId: string) {
      // A DEX that cannot tell whether it lists the pool (its pool list is down) throws; the others still get asked,
      // and the first such error is rethrown only when no DEX answered, so the caller never reads it as "unlisted".
      let failure: { error: unknown } | null = null;
      for (const entry of modules) {
        if (!entry.poolDailyApr) continue;
        try {
          const result = await entry.poolDailyApr(poolId);
          if (result) return result;
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
      return null;
    },
    async recordDailyTvl(input: DailyTvlRecordInput) {
      const stats: Partial<Record<DexId, DailyTvlStats>> = {};
      const issues: string[] = [];
      const failures: { dex: DexId; displayName: string; error: unknown }[] = [];
      for (const entry of modules) {
        if (!entry.recordDailyTvl) continue;
        try {
          const result = await entry.recordDailyTvl(input);
          stats[entry.descriptor.id] = result.stats;
          issues.push(...result.issues);
        } catch (error) {
          failures.push({ dex: entry.descriptor.id, displayName: entry.descriptor.displayName, error });
        }
      }
      return { stats, issues, failures };
    },
  });
}
