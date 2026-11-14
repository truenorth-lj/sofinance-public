// Discovery metadata only. Surface differences are retained as wire contracts.
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
const TOOL_DEFINITIONS = {
    prepare_withdraw: { name: "prepare_withdraw", description: "Prepare a fully simulated position withdrawal with a sign link. Default receive USDC; original keeps position tokens. Supply percent (1–100) OR targetUSDC. Impact above 5% requires confirmHighImpact. For two transactions, finalize the first then call again with stage=swap, tx1Signature and previous (the complete first result).", inputSchema: { type: "object" as const, properties: { wallet: { type: "string" }, positionMint: { type: "string" }, percent: { type: "number", minimum: 1, maximum: 100 }, targetUSDC: { type: "number" }, receive: { type: "string", enum: ["usdc", "token", "original"] }, outputMint: { type: "string" }, confirmHighImpact: { type: "boolean" }, stage: { type: "string", enum: ["swap"] }, tx1Signature: { type: "string" }, previous: { type: "object" } }, oneOf: [{ required: ["percent"] }, { required: ["targetUSDC"] }], required: ["wallet", "positionMint"] } },
    submit_withdraw: { name: "submit_withdraw", description: "Submit a wallet signed withdrawal. Verifies its HMAC permit and signature, checks expiry, and re-simulates before broadcast. Supply the unchanged summary and permit from prepare_withdraw. If the wallet appended extra instructions (e.g. Phantom Lighthouse), also pass unsignedTransaction from prepare_withdraw. High impact requires confirmHighImpact=true.", inputSchema: { type: "object" as const, properties: { wallet: { type: "string" }, signedTransaction: { type: "string" }, unsignedTransaction: { type: "string" }, permit: { type: "string" }, summary: { type: "object" }, confirmHighImpact: { type: "boolean" } }, required: ["wallet", "signedTransaction", "permit", "summary"] } },
    get_position_performance: {
        name: "get_position_performance",
        description: "Compute holding-period return and realized fee APR for a Raydium CLMM position NFT from finalized history and current on-chain state (not Raydium pool 24h feeApr). Prefer token-native metrics: for same-asset RWA wrap pairs (e.g. SPCXx/SPCX) report TE in the plain/base ticker using current tick mid (1.0001^tick×10^(decA−decB)), plus raw A/B inventory, holdingDays, feeOnlyAprPct and annualizedReturnPct (HPR×365/days; feesEarned/deposited×365/days). USD is optional/secondary (Jupiter Price v3 / Raydium stable-leg, labeled current — not historical). Discovers open/increase/decrease txs via personal-position signatures + Anchor events + current equity. After submitting a position transaction, use refreshHistory=true and historyAfterSignatures to require its finalized history. Read-only.",
        inputSchema: {
            type: "object",
            properties: {
                positionMint: {
                    type: "string",
                    description: "Position NFT mint address (from list_positions)",
                },
                wallet: {
                    type: "string",
                    description: "Optional wallet to verify NFT ownership (does not change math)",
                },
                maxSignatures: {
                    type: "number",
                    description: "Max personal-position signatures to scan (1-500, default 100)",
                    default: 100,
                },
                refreshHistory: { type: "boolean", description: "Force a fresh history read after a transaction" },
                historyAfterSignatures: { type: "array", maxItems: 8, items: { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{64,88}$" } },
                skipPricing: {
                    type: "boolean",
                    description: "If true, skip Jupiter/Raydium USD pricing (token-native / TE metrics still computed)",
                    default: false,
                },
            },
            required: ["positionMint"],
        },
    },
    get_position_range_status: {
        name: "get_position_range_status",
        description: "Compute live in-range / out-of-range status for a Raydium CLMM position from the current on-chain pool price versus tickLower/tickUpper (B per 1 A). Flags when price approaches a range edge. Read-only.",
        inputSchema: {
            type: "object",
            properties: {
                positionMint: {
                    type: "string",
                    description: "Position NFT mint address",
                },
                wallet: {
                    type: "string",
                    description: "Optional wallet; when set it must match the Bearer token",
                },
                poolId: {
                    type: "string",
                    description: "Optional pool override (defaults to the position's pool)",
                },
            },
            required: ["positionMint"],
        },
    },
    list_rwa_pairs: {
        name: "list_rwa_pairs",
        title: "List same-stock pools",
        description: "List the same-stock Solana pools on the SoFinance pools page (https://sofinancelab.xyz/app/rwa-pairs): Raydium CLMM and Meteora DLMM pools where both sides are the same stock from two issuers (e.g. TSLA/TSLAx, SPCX/SPCXx), plus the USDC/USDT pool. Served from the site's saved pools snapshot, the same list the page shows. Each pool has protocol, symbols, fee tier, TVL, 24h volume, apr7d (the highest 7-day range fee APR estimate and which of the 4 range presets it comes from: Micro, Tight, Standard, Wide), and an openPositionUrl. Filter with symbol (e.g. \"TSLA\"). Default order: 7-day APR, high to low. estimatedFeeAprPct / estimatedFeeAprLabel are the older pool-level 24-hour figure (last 24h fees / TVL, annualized), not a 7-day estimate; small pools can show very large values, and a pool without a 7-day estimate carries a warning. Estimates from past trading, not a promise of future fees. Fees not guaranteed. For the 4 presets of one pool call get_pool_range_apr. No wallet or token needed. Opening a position through MCP (quote_open_position / prepare_open_position) is Raydium CLMM only and needs a wallet token; Meteora pools open on the website.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Optional ticker filter, e.g. TSLA or TSLAx (case-insensitive; matches either token or the base ticker)",
                },
                minTvl: {
                    type: "number",
                    description: "Minimum pool TVL in USD (default 0)",
                    default: 0,
                },
                sortBy: {
                    type: "string",
                    enum: ["apr7d", "estimatedFeeApr", "tvl", "volume24h"],
                    description: "Sort key (default apr7d, the 7-day estimate the site ranks by). estimatedFeeApr is the older pool-level 24h figure.",
                    default: "apr7d",
                },
                maxPages: {
                    type: "number",
                    description: "Deprecated, ignored: the list comes from the saved snapshot.",
                },
            },
            required: [],
        },
    },
    get_pool_range_apr: {
        name: "get_pool_range_apr",
        title: "7-day range APR for a pool",
        description: "Estimated 7-day fee APR of one listed pool (poolAddress from list_rwa_pairs, Raydium or Meteora) for each of the 4 range presets the site prices: Micro (±2 price steps), Tight (±0.05%), Standard (±0.3%), Wide (±1%). Per preset: price bounds (B per 1 A), APR %, share of the last 7 days' volume that traded inside the range, and fees per day at the site's $1,000 card basis. Also the highest-APR preset, the 7-day window, data freshness and confidence. Same saved snapshot as the pool cards on https://sofinancelab.xyz/app/rwa-pairs. New pools (too few days of data) and missing snapshots return a status with a reason and no APR. Estimates from past trading, not a promise of future fees. Fees not guaranteed. No wallet or token needed.",
        inputSchema: {
            type: "object",
            properties: {
                poolId: { type: "string", description: "Pool address (poolAddress from list_rwa_pairs)" },
            },
            required: ["poolId"],
        },
    },
    list_positions: {
        name: "list_positions",
        description: "List all Raydium CLMM positions and wallet assets. Returns position NFTs (with pool, ticks, liquidity) and eligible input assets (SOL, tokens) with balances. Read-only, no private keys required. Use this first to discover available positions and assets.",
        inputSchema: {
            type: "object",
            properties: {
                wallet: {
                    type: "string",
                    description: "Solana wallet public key (base58, 32-44 chars)",
                },
            },
            required: ["wallet"],
        },
    },
    quote_add_liquidity: {
        name: "quote_add_liquidity",
        description: "Get a quote for adding liquidity to a position. Estimates swap routes (Jupiter), price impact, output amounts, and immediate resale gap. Verifies NFT ownership, pool state, and balance. Read-only. Quotes expire quickly (configured TTL). Failure modes: insufficient balance, high price impact (>5%), resale floor breach, quote expiration, pool state changes.",
        inputSchema: {
            type: "object",
            properties: {
                wallet: {
                    type: "string",
                    description: "Wallet public key",
                },
                positionMint: {
                    type: "string",
                    description: "Position NFT mint address (from list_positions)",
                },
                inputMint: {
                    type: "string",
                    description: "Input asset mint address (from list_positions assets)",
                },
                inputKind: {
                    type: "string",
                    enum: ["native", "token"],
                    description: "Asset kind: 'native' for SOL, 'token' for SPL tokens",
                },
                amount: {
                    type: "string",
                    description: "Amount in token units (e.g. '1.5' for 1.5 SOL)",
                },
                resaleFloorBps: {
                    type: "number",
                    description: "Minimum resale ratio in basis points (9500-10000, default 9900 = 1% max loss). Conservative immediate-resale protection.",
                    default: 9900,
                },
                slippageToleranceBps: {
                    type: "number",
                    description: "Add-liquidity price tolerance in basis points (0-500, multiple of 10, default 100 = 1%). Liquidity is sized so the pool price may drift this much before execution; the unused reserve stays in the wallet. Jupiter swap slippage stays fixed at 0.5%.",
                    default: 100,
                },
            },
            required: ["wallet", "positionMint", "inputMint", "inputKind", "amount"],
        },
    },
    prepare_transaction: {
        name: "prepare_transaction",
        description: "Prepare an unsigned, fully-simulated transaction for adding liquidity. Returns base64-encoded transaction for signing, HMAC permit, and summary. The server NEVER holds private keys. Transaction must be signed by the user/agent wallet. Includes: full simulation, 1232-byte limit check, Jupiter swap + Raydium increase_liquidity_v2, short-lived permit. Failure modes: same as quote_add_liquidity, plus simulation failure, size limit, blockhash expiry. After signing, use submit_signed_transaction.",
        inputSchema: {
            type: "object",
            properties: {
                wallet: {
                    type: "string",
                    description: "Wallet public key",
                },
                positionMint: {
                    type: "string",
                    description: "Position NFT mint address",
                },
                inputMint: {
                    type: "string",
                    description: "Input asset mint address",
                },
                inputKind: {
                    type: "string",
                    enum: ["native", "token"],
                    description: "Asset kind: 'native' or 'token'",
                },
                amount: {
                    type: "string",
                    description: "Amount in token units",
                },
                resaleFloorBps: {
                    type: "number",
                    description: "Resale floor in basis points (9500-10000, default 9900)",
                    default: 9900,
                },
                slippageToleranceBps: {
                    type: "number",
                    description: "Add-liquidity price tolerance in basis points (0-500, multiple of 10, default 100)",
                    default: 100,
                },
            },
            required: ["wallet", "positionMint", "inputMint", "inputKind", "amount"],
        },
    },
    quote_compound: {
        name: "quote_compound",
        description: "Get a quote for compounding a position (harvest fees/rewards, swap to ratio, reinvest). Returns expected liquidity increase, swap plan, simulation results. Verifies position eligibility. Read-only. Phase one: rejects third reward tokens (no verifiable swap path). Failure modes: ineligible position, third reward token, insufficient harvested fees for minimum liquidity unit, swap plan failure.",
        inputSchema: {
            type: "object",
            properties: {
                wallet: {
                    type: "string",
                    description: "Wallet public key",
                },
                positionMint: {
                    type: "string",
                    description: "Position NFT mint address",
                },
                sourceSignatures: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional: prior harvest transaction signatures to merge (max 3)",
                    maxItems: 3,
                },
            },
            required: ["wallet", "positionMint"],
        },
    },
    prepare_compound_transaction: {
        name: "prepare_compound_transaction",
        description: "Prepare an unsigned compound transaction. Returns base64 transaction, permit, and summary. Same safety as prepare_transaction: full simulation, HMAC permit, no private keys. After signing, use submit_compound_transaction.",
        inputSchema: {
            type: "object",
            properties: {
                wallet: {
                    type: "string",
                    description: "Wallet public key",
                },
                positionMint: {
                    type: "string",
                    description: "Position NFT mint address",
                },
                sourceSignatures: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional: prior harvest signatures (max 3)",
                    maxItems: 3,
                },
            },
            required: ["wallet", "positionMint"],
        },
    },
    submit_signed_transaction: {
        name: "submit_signed_transaction",
        description: "Submit a signed add-liquidity transaction. Re-verifies HMAC permit, re-reads on-chain state, re-simulates, then broadcasts. Pass signedTransaction plus every field of submitArgs from the prepare_transaction response, unchanged. Failure modes: permit mismatch, state changed (liquidity, balance, NFT), expired (time or blockhash), simulation failure. Returns transaction signature on success.",
        inputSchema: {
            type: "object",
            properties: {
                signedTransaction: {
                    type: "string",
                    description: "Base64-encoded signed transaction",
                },
                unsignedTransaction: {
                    type: "string",
                    description: "Base64 prepared transaction from prepare_transaction. Pass this when the wallet rewrote the message (Phantom Lighthouse / ComputeBudget).",
                },
                permit: {
                    type: "string",
                    description: "HMAC permit from prepare_transaction",
                },
                wallet: {
                    type: "string",
                    description: "Wallet public key",
                },
                selection: {
                    type: "object",
                    properties: {
                        positionMint: { type: "string" },
                        inputMint: { type: "string" },
                        inputKind: { type: "string", enum: ["native", "token"] },
                    },
                    required: ["positionMint", "inputMint", "inputKind"],
                },
                requested: {
                    type: "string",
                    description: "Requested amount from summary",
                },
                expectedLiquidity: {
                    type: "string",
                    description: "Expected liquidity from summary",
                },
                startingLiquidity: {
                    type: "string",
                    description: "Starting liquidity from summary",
                },
                floorBps: {
                    type: "number",
                    description: "Resale floor basis points",
                },
                expiresAt: {
                    type: "number",
                    description: "Expiry timestamp (ms) from summary",
                },
                lastValidBlockHeight: {
                    type: "number",
                    description: "Block height from summary",
                },
                rangeSide: {
                    type: "string",
                    enum: ["below", "inside", "above"],
                    description: "Position range side from summary",
                },
                startingBalances: {
                    type: "object",
                    properties: {
                        input: { type: "string" },
                        a: { type: "string" },
                        b: { type: "string" },
                    },
                    required: ["input", "a", "b"],
                },
            },
            required: [
                "signedTransaction",
                "permit",
                "wallet",
                "selection",
                "requested",
                "expectedLiquidity",
                "startingLiquidity",
                "floorBps",
                "expiresAt",
                "lastValidBlockHeight",
                "rangeSide",
                "startingBalances",
            ],
        },
    },
    submit_compound_transaction: {
        name: "submit_compound_transaction",
        description: "Submit a signed compound transaction. Re-verifies permit and summary, then broadcasts. Returns signature on success. Same safety as submit_signed_transaction.",
        inputSchema: {
            type: "object",
            properties: {
                signedTransaction: {
                    type: "string",
                    description: "Base64-encoded signed transaction",
                },
                unsignedTransaction: {
                    type: "string",
                    description: "Base64 prepared transaction from prepare_compound_transaction. Pass this when the wallet rewrote the message (Phantom Lighthouse / ComputeBudget).",
                },
                permit: {
                    type: "string",
                    description: "HMAC permit from prepare_compound_transaction",
                },
                wallet: {
                    type: "string",
                    description: "Wallet public key",
                },
                summary: {
                    type: "object",
                    description: "Complete summary object from prepare_compound_transaction response, unchanged (bound by the permit)",
                },
            },
            required: ["signedTransaction", "permit", "wallet", "summary"],
        },
    },
    quote_open_position: {
        name: "quote_open_position",
        description: "Quote opening a NEW Raydium CLMM position in a pool (no existing NFT). Input SOL/USDC/pool token, amount, and a price range (presets tight ±0.05% / standard ±0.3% / wide ±1%, or custom minPrice/maxPrice in B per 1 A). Returns expected A/B after Jupiter swap-to-ratio, tick-aligned range, in/out-of-range, price impact, refundable vs non-refundable SOL rent (NFT + tick arrays), and Token-2022/freeze flags. Fails clearly on insufficient balance, >5% impact, transfer-fee/freeze, or unfunded tick arrays the wallet cannot pay. Read-only.",
        inputSchema: {
            type: "object",
            properties: {
                wallet: { type: "string", description: "Wallet public key" },
                poolId: { type: "string", description: "Raydium CLMM pool id (from list_rwa_pairs)" },
                inputMint: { type: "string", description: "\"SOL\" or \"USDC\" (resolved to So11111111111111111111111111111111111111112 / EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v), or a mint address in the pool" },
                inputKind: { type: "string", enum: ["native", "token"], description: "'native' for SOL, 'token' otherwise" },
                amount: { type: "string", description: "Amount in token units (e.g. '1.5')" },
                rangePreset: {
                    type: "string",
                    enum: ["tight", "standard", "wide", "custom"],
                    description: "Default standard (±0.3% around current B-per-A price)",
                    default: "standard",
                },
                minPrice: { type: "string", description: "Custom range min price (B per 1 A), required if rangePreset=custom" },
                maxPrice: { type: "string", description: "Custom range max price (B per 1 A), required if rangePreset=custom" },
                resaleFloorBps: {
                    type: "number",
                    description: "Minimum resale ratio in basis points (9500-10000, default 9900)",
                    default: 9900,
                },
                slippageToleranceBps: {
                    type: "number",
                    description: "Open-position price tolerance in basis points (0-500, default 100). Jupiter swap slippage stays 0.5%.",
                    default: 100,
                },
            },
            required: ["wallet", "poolId", "inputMint", "inputKind", "amount"],
        },
    },
    prepare_open_position: {
        name: "prepare_open_position",
        description: "Prepare an unsigned, fully-simulated transaction that opens a new CLMM position. Prefer passing nftMint from an agent-held Keypair so the server never signs: wallet signs first, then add the mint signature on the wallet-returned tx and call submit_open_position. Without nftMint, open signUrl: the sign page generates the mint in the browser, re-prepares, wallet signs first, then the mint (the returned tx is a preview only). HMAC permit, summary, signUrl. 1232-byte limit, fresh blockhash, full simulation. Not submit_signed_transaction — this tx has two required signers.",
        inputSchema: {
            type: "object",
            properties: {
                wallet: { type: "string", description: "Wallet public key" },
                poolId: { type: "string", description: "Raydium CLMM pool id" },
                inputMint: { type: "string", description: "Input asset mint, or \"SOL\" / \"USDC\"" },
                inputKind: { type: "string", enum: ["native", "token"] },
                amount: { type: "string", description: "Amount in token units" },
                rangePreset: {
                    type: "string",
                    enum: ["tight", "standard", "wide", "custom"],
                    default: "standard",
                },
                minPrice: { type: "string" },
                maxPrice: { type: "string" },
                resaleFloorBps: { type: "number", default: 9900 },
                slippageToleranceBps: { type: "number", default: 100 },
                nftMint: {
                    type: "string",
                    description: "Client-generated position NFT mint public key. Prefer this so the server never signs. Omit only for the MCP signUrl fallback.",
                },
            },
            required: ["wallet", "poolId", "inputMint", "inputKind", "amount"],
        },
    },
    submit_open_position: {
        name: "submit_open_position",
        description: "Submit a signed open-position transaction. Re-verifies HMAC permit, re-reads pool/balances, re-simulates (sigVerify true, including the NFT-mint partial signature), then broadcasts. Pass signedTransaction plus permit, wallet, and the complete summary from prepare_open_position, unchanged. If the wallet rewrote the message (Phantom Lighthouse / ComputeBudget), also pass unsignedTransaction from prepare. Returns signature and the new positionMint.",
        inputSchema: {
            type: "object",
            properties: {
                signedTransaction: { type: "string", description: "Base64-encoded signed transaction" },
                unsignedTransaction: { type: "string", description: "Base64 prepared transaction from prepare_open_position. Pass this when the wallet rewrote the message (Phantom Lighthouse / ComputeBudget)." },
                permit: { type: "string", description: "HMAC permit from prepare_open_position" },
                wallet: { type: "string", description: "Wallet public key" },
                summary: {
                    type: "object",
                    description: "Complete summary object from prepare_open_position, unchanged (bound by the permit)",
                },
            },
            required: ["signedTransaction", "permit", "wallet", "summary"],
        },
    },
} satisfies Record<string, Tool>;
export type ToolName = keyof typeof TOOL_DEFINITIONS;
type ToolAnnotations = NonNullable<Tool["annotations"]>;
/** Reads saved SoFinance pool snapshots only: no wallet, no chain call on the hosted server. */
const SNAPSHOT_READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Reads chain state / quotes routes; changes nothing. */
const CHAIN_READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Builds and simulates an unsigned transaction and a sign link; nothing moves until the wallet signs. */
const PREPARE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** Broadcasts a wallet-signed transaction: funds move and it cannot be undone. */
const SUBMIT: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
/** MCP tool annotations (hints for clients and directories; never a security boundary). */
const TOOL_ANNOTATIONS = {
    list_rwa_pairs: SNAPSHOT_READ,
    get_pool_range_apr: SNAPSHOT_READ,
    list_positions: CHAIN_READ,
    get_position_range_status: CHAIN_READ,
    get_position_performance: CHAIN_READ,
    quote_add_liquidity: CHAIN_READ,
    quote_compound: CHAIN_READ,
    quote_open_position: CHAIN_READ,
    prepare_transaction: PREPARE,
    prepare_compound_transaction: PREPARE,
    prepare_open_position: PREPARE,
    prepare_withdraw: PREPARE,
    submit_signed_transaction: SUBMIT,
    submit_compound_transaction: SUBMIT,
    submit_open_position: SUBMIT,
    submit_withdraw: SUBMIT,
} as const satisfies Record<ToolName, ToolAnnotations>;
/** Tools the remote server answers without a bearer token (read-only snapshot tools). Mirrors dispatch `access`. */
export const PUBLIC_TOOL_NAMES = ["list_rwa_pairs", "get_pool_range_apr"] as const satisfies readonly ToolName[];
export type McpSurface = "http" | "stdio";
const HTTP_ORDER = ["prepare_withdraw", "submit_withdraw", "get_position_performance", "get_position_range_status", "list_rwa_pairs", "get_pool_range_apr", "list_positions", "quote_add_liquidity", "prepare_transaction", "quote_compound", "prepare_compound_transaction", "submit_signed_transaction", "submit_compound_transaction", "quote_open_position", "prepare_open_position", "submit_open_position"] as const satisfies readonly ToolName[];
const STDIO_ORDER: readonly ToolName[] = [
    ...HTTP_ORDER.filter(name => name !== "submit_compound_transaction"),
    "submit_compound_transaction",
];
// Preserve the existing stdio wording; changing discovery text is a separate contract change.
const STDIO_OPEN_DEFINITION = {
    ...TOOL_DEFINITIONS.quote_open_position,
    inputSchema: {
        ...TOOL_DEFINITIONS.quote_open_position.inputSchema,
        properties: {
            ...TOOL_DEFINITIONS.quote_open_position.inputSchema.properties,
            resaleFloorBps: {
                ...TOOL_DEFINITIONS.quote_open_position.inputSchema.properties.resaleFloorBps,
                description: "Minimum conservative immediate-resale ratio in basis points (9500-10000, default 9900). Agents must pass this explicitly to override the default floor.",
            },
        },
    },
} satisfies Tool;
/** Return detached metadata so callers cannot mutate another transport's definitions. */
export function listToolDefinitions(surface: McpSurface): Tool[] {
    const order = surface === "http" ? HTTP_ORDER : STDIO_ORDER;
    return order.map(name => structuredClone({
        ...(surface === "stdio" && name === "quote_open_position" ? STDIO_OPEN_DEFINITION : TOOL_DEFINITIONS[name]),
        annotations: TOOL_ANNOTATIONS[name],
    }));
}
