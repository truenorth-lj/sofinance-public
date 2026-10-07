"use client";

import { useState } from "react";
import { Copy, CheckCircle2, ExternalLink, Wallet, Sparkles } from "lucide-react";
import { InkShell, InkNav, InkCard } from "@/components/ink";
import { useWalletConnection } from "@/components/wallet-connection";

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;

interface ConfigOption {
  title: string;
  description: string;
  config: string;
}

export default function AIGuidePage() {
  const { address: wallet, connected, connect, disconnect } = useWalletConnection();
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://sofinance-alpha.vercel.app";
  
  const configOptions: ConfigOption[] = [
    {
      title: "Option A: Direct MCP Server (Recommended)",
      description: "Run the MCP server directly from the SoFinance repository",
      config: JSON.stringify({
        mcpServers: {
          sofinance: {
            command: "npx",
            args: ["tsx", "src/mcp/server.ts"],
            cwd: "/absolute/path/to/sofinance-public",
            env: {
              SOLANA_RPC_URL: "https://your-solana-rpc-url",
              JUPITER_API_KEY: "your-jupiter-api-key",
              NEXT_PUBLIC_APP_URL: appUrl,
            },
          },
        },
      }, null, 2),
    },
    {
      title: "Option B: Using pnpm script",
      description: "Alternative setup using pnpm commands",
      config: JSON.stringify({
        mcpServers: {
          sofinance: {
            command: "pnpm",
            args: ["mcp:start"],
            cwd: "/absolute/path/to/sofinance-public",
            env: {
              SOLANA_RPC_URL: "https://your-solana-rpc-url",
              JUPITER_API_KEY: "your-jupiter-api-key",
              NEXT_PUBLIC_APP_URL: appUrl,
            },
          },
        },
      }, null, 2),
    },
  ];

  const handleCopy = async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  return (
    <InkShell>
      <InkNav 
        wallet={wallet} 
        connected={connected} 
        onConnect={connect} 
        onDisconnect={disconnect} 
      />

      <div className="mb-6 mt-8 sm:mt-10">
        <div className="flex items-center gap-3">
          <Sparkles className="h-6 w-6 text-neutral-400" />
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100 sm:text-3xl">
            Use AI to manage
          </h1>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-neutral-500">
          Connect an AI agent like Cursor to manage your Raydium CLMM positions
        </p>
      </div>

      <div className="space-y-6">
        <InkCard>
          <h2 className="text-lg font-semibold text-neutral-100">
            How it works
          </h2>
          <div className="mt-4 space-y-4 text-sm leading-relaxed text-neutral-400">
            <div className="flex gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800 text-xs font-semibold text-neutral-300">
                1
              </div>
              <div>
                <p className="font-medium text-neutral-300">Connect your wallet</p>
                <p className="mt-1">Connect your Solana wallet to authenticate ownership.</p>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800 text-xs font-semibold text-neutral-300">
                2
              </div>
              <div>
                <p className="font-medium text-neutral-300">Copy MCP configuration</p>
                <p className="mt-1">
                  Copy the MCP server config with your credentials and repository path.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800 text-xs font-semibold text-neutral-300">
                3
              </div>
              <div>
                <p className="font-medium text-neutral-300">Add to Cursor MCP settings</p>
                <p className="mt-1">
                  Paste the config into your Cursor MCP settings (Settings → Features → MCP Servers).
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800 text-xs font-semibold text-neutral-300">
                4
              </div>
              <div>
                <p className="font-medium text-neutral-300">AI agent prepares transactions</p>
                <p className="mt-1">
                  The agent calls the MCP server to prepare transactions, which returns a sign URL.
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-700 bg-neutral-800 text-xs font-semibold text-neutral-300">
                5
              </div>
              <div>
                <p className="font-medium text-neutral-300">Sign in browser</p>
                <p className="mt-1">
                  Open the sign URL in your browser, connect your wallet, and sign the transaction.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-blue-900/50 bg-blue-950/20 p-4">
            <p className="text-sm font-medium text-blue-400">Zero local secrets required</p>
            <p className="mt-2 text-xs leading-relaxed text-blue-300">
              Your private keys never leave your wallet. The MCP server prepares unsigned transactions, 
              and you review and sign them in your browser with your connected wallet.
            </p>
          </div>
        </InkCard>

        {!connected ? (
          <InkCard>
            <div className="flex items-center gap-4">
              <Wallet className="h-8 w-8 text-neutral-500" />
              <div className="flex-1">
                <h3 className="font-semibold text-neutral-100">Connect wallet to continue</h3>
                <p className="mt-1 text-sm text-neutral-500">
                  Connect your Solana wallet to view MCP configuration options.
                </p>
              </div>
              <button
                onClick={connect}
                className="rounded-xl border border-neutral-700 bg-transparent px-4 py-3 text-sm font-semibold text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50"
              >
                Connect wallet
              </button>
            </div>
          </InkCard>
        ) : (
          <>
            <InkCard>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-neutral-100">Wallet connected</h3>
                  <p className="mt-1 font-mono text-sm text-neutral-400">{short(wallet!)}</p>
                </div>
                <button
                  onClick={disconnect}
                  className="rounded-xl border border-neutral-700 bg-transparent px-3 py-2 text-xs font-semibold text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50"
                >
                  Disconnect
                </button>
              </div>
            </InkCard>

            <InkCard>
              <h2 className="text-lg font-semibold text-neutral-100">
                MCP Configuration
              </h2>
              <p className="mt-2 text-sm text-neutral-500">
                Choose your preferred setup method and copy the configuration below.
              </p>

              <div className="mt-6 space-y-6">
                {configOptions.map((option, index) => (
                  <div key={index} className="space-y-3">
                    <div>
                      <h3 className="font-semibold text-neutral-200">{option.title}</h3>
                      <p className="mt-1 text-sm text-neutral-500">{option.description}</p>
                    </div>

                    <div className="relative">
                      <pre className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-950 p-4 text-xs text-neutral-300">
                        <code>{option.config}</code>
                      </pre>
                      <button
                        onClick={() => handleCopy(option.config, index)}
                        className="absolute right-3 top-3 rounded-lg border border-neutral-700 bg-neutral-900/90 p-2 transition-colors hover:border-neutral-600 hover:bg-neutral-800"
                        aria-label="Copy configuration"
                      >
                        {copiedIndex === index ? (
                          <CheckCircle2 className="h-4 w-4 text-green-400" />
                        ) : (
                          <Copy className="h-4 w-4 text-neutral-400" />
                        )}
                      </button>
                    </div>

                    {index === 0 && (
                      <div className="rounded-lg border border-neutral-800/60 bg-neutral-900/50 p-3 text-xs text-neutral-500">
                        <p className="font-semibold text-neutral-400">⚠️ Before using:</p>
                        <ul className="mt-2 space-y-1 pl-4 leading-relaxed">
                          <li className="list-disc">
                            Replace <code className="text-neutral-300">/absolute/path/to/sofinance-public</code> with 
                            your actual repository path
                          </li>
                          <li className="list-disc">
                            Set your <code className="text-neutral-300">SOLANA_RPC_URL</code> (e.g., from Helius, QuickNode)
                          </li>
                          <li className="list-disc">
                            Set your <code className="text-neutral-300">JUPITER_API_KEY</code> (get one at{" "}
                            <a 
                              href="https://station.jup.ag/api-keys" 
                              target="_blank" 
                              rel="noreferrer"
                              className="text-neutral-300 underline hover:text-neutral-100"
                            >
                              Jupiter Station
                            </a>)
                          </li>
                          <li className="list-disc">
                            Ensure Node.js 20+ and pnpm are installed, and run{" "}
                            <code className="text-neutral-300">pnpm install</code> in the repository
                          </li>
                        </ul>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </InkCard>

            <InkCard>
              <h2 className="text-lg font-semibold text-neutral-100">
                Available MCP Tools
              </h2>
              <p className="mt-2 text-sm text-neutral-500">
                Once configured, your AI agent will have access to these capabilities:
              </p>

              <div className="mt-4 grid gap-3 text-sm">
                <ToolItem 
                  name="list_positions"
                  description="View all Raydium CLMM positions in your wallet"
                />
                <ToolItem 
                  name="get_position_state"
                  description="Get detailed state for a specific position (balances, price, range)"
                />
                <ToolItem 
                  name="quote_add_liquidity"
                  description="Get a quote for adding liquidity to a position"
                />
                <ToolItem 
                  name="prepare_transaction"
                  description="Prepare an unsigned add-liquidity transaction"
                />
                <ToolItem 
                  name="quote_compound"
                  description="Get a quote for compounding yield back into a position"
                />
                <ToolItem 
                  name="prepare_compound_transaction"
                  description="Prepare an unsigned compound transaction"
                />
                <ToolItem 
                  name="list_rwa_pairs"
                  description="Discover same-asset RWA pairs (e.g., MSTRx/MSTR)"
                />
                <ToolItem 
                  name="get_position_performance"
                  description="Calculate holding-period return and realized fee APR"
                />
              </div>
            </InkCard>

            <InkCard>
              <h2 className="text-lg font-semibold text-neutral-100">
                Security & Safety
              </h2>
              <div className="mt-4 space-y-4 text-sm leading-relaxed text-neutral-400">
                <div className="flex gap-3">
                  <div className="text-green-400">✓</div>
                  <div>
                    <p className="font-medium text-neutral-300">Private keys never exposed</p>
                    <p className="mt-1">
                      The MCP server only prepares unsigned transactions. Your wallet signs them in the browser.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="text-green-400">✓</div>
                  <div>
                    <p className="font-medium text-neutral-300">Same safety checks as web UI</p>
                    <p className="mt-1">
                      All MCP tools use the same validation, price impact checks, and resale floor guarantees as the web interface.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="text-green-400">✓</div>
                  <div>
                    <p className="font-medium text-neutral-300">Transaction re-verification</p>
                    <p className="mt-1">
                      Every transaction is re-simulated and verified server-side before signing to ensure quotes haven't expired.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="text-green-400">✓</div>
                  <div>
                    <p className="font-medium text-neutral-300">Time-limited sign tokens</p>
                    <p className="mt-1">
                      Sign URLs expire after 60-120 seconds to match blockhash and permit lifetimes.
                    </p>
                  </div>
                </div>
              </div>
            </InkCard>

            <InkCard>
              <h2 className="text-lg font-semibold text-neutral-100">
                Next Steps
              </h2>
              <div className="mt-4 space-y-3 text-sm leading-relaxed text-neutral-400">
                <p>After adding the MCP configuration to Cursor:</p>
                <ol className="space-y-2 pl-5">
                  <li className="list-decimal">
                    <span className="font-medium text-neutral-300">Restart Cursor</span> to load the new MCP server
                  </li>
                  <li className="list-decimal">
                    <span className="font-medium text-neutral-300">Open Cursor Chat</span> and verify the "sofinance" MCP server appears in available tools
                  </li>
                  <li className="list-decimal">
                    <span className="font-medium text-neutral-300">Try a command</span> like "List my Raydium positions" or "Show position performance"
                  </li>
                  <li className="list-decimal">
                    When the agent prepares a transaction, it will give you a <span className="font-medium text-neutral-300">sign URL</span>
                  </li>
                  <li className="list-decimal">
                    <span className="font-medium text-neutral-300">Open the URL</span> in your browser, connect your wallet, review, and sign
                  </li>
                </ol>
              </div>

              <div className="mt-6">
                <a
                  href="https://github.com/truenorth-lj/sofinance-public#quickstart--mcp-claude-desktop--cursor"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-sm font-semibold text-neutral-300 transition-colors hover:text-neutral-100"
                >
                  View full documentation
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            </InkCard>
          </>
        )}
      </div>
    </InkShell>
  );
}

function ToolItem({ name, description }: { name: string; description: string }) {
  return (
    <div className="rounded-lg border border-neutral-800/60 bg-neutral-900/30 p-3">
      <div className="flex items-start gap-3">
        <code className="rounded bg-neutral-800 px-2 py-1 text-xs font-semibold text-neutral-300">
          {name}
        </code>
        <p className="flex-1 text-xs leading-relaxed text-neutral-500">{description}</p>
      </div>
    </div>
  );
}
