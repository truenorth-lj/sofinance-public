"use client";

import { InkShell, InkNav, InkCard } from "@/components/ink";
import { useWalletConnection } from "@/components/wallet-connection";
import { McpConnectionCard } from "@/components/mcp-connection-card";
import { Wallet, Sparkles, Code, Link as LinkIcon } from "lucide-react";

export default function AIManagementPage() {
  const { address: wallet, connected, connect, disconnect } = useWalletConnection();

  return (
    <InkShell maxWidth="5xl">
      <InkNav wallet={wallet} connected={connected} onConnect={connect} onDisconnect={disconnect} />

      <div className="mb-6 mt-8 sm:mt-10">
        <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          <Sparkles className="h-7 w-7 text-neutral-400" />
          Manage positions with AI
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-500">
          Connect your wallet to get started with AI-powered position management via MCP
        </p>
      </div>

      {!connected ? (
        <InkCard>
          <div className="space-y-6">
            <div className="flex items-start gap-4">
              <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 p-3">
                <Wallet className="h-6 w-6 text-neutral-300" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-neutral-100">
                  Step 1: Connect your wallet
                </h2>
                  <p className="mt-2 text-sm leading-6 text-neutral-400">
                    Connect your wallet to start. Connecting only opens a session — you&apos;ll
                    still sign a message in the next step to prove you control the key.
                  </p>
                <button
                  onClick={connect}
                  className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-700 bg-transparent px-4 py-2.5 text-sm font-semibold text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-900/50"
                >
                  <Wallet className="h-4 w-4" />
                  Connect wallet
                </button>
              </div>
            </div>

            <div className="border-t border-neutral-800/60 pt-6">
              <div className="flex items-start gap-4 opacity-50">
                <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 p-3">
                  <Code className="h-6 w-6 text-neutral-300" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-neutral-100">
                    Step 2: Copy MCP configuration
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-neutral-400">
                    After connecting, click Sign to get MCP config, approve the wallet prompt,
                    then copy the snippet into your AI agent&apos;s MCP settings.
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t border-neutral-800/60 pt-6">
              <div className="flex items-start gap-4 opacity-50">
                <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 p-3">
                  <LinkIcon className="h-6 w-6 text-neutral-300" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-neutral-100">
                    Step 3: Start using AI agents
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-neutral-400">
                    Your AI agent will be able to list positions and RWA pairs, quote add-liquidity /
                    compound / open-position, and prepare unsigned transactions (12 MCP tools). When
                    ready to sign, open the provided link with your wallet connected for one-click approval.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </InkCard>
      ) : (
        <div className="space-y-6">
          <InkCard>
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="rounded-lg border border-green-900/50 bg-green-950/30 p-3">
                  <Wallet className="h-6 w-6 text-green-400" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-neutral-100">
                    Wallet connected
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-neutral-400">
                    Your wallet is connected. Sign below to mint a wallet-bound MCP token — a
                    WalletConnect session alone is not enough.
                  </p>
                  <div className="mt-3 flex items-center gap-2 text-xs">
                    <span className="text-neutral-500">Address:</span>
                    <code className="rounded bg-neutral-800 px-2 py-1 font-mono text-neutral-300">
                      {wallet ? `${wallet.slice(0, 8)}...${wallet.slice(-8)}` : ""}
                    </code>
                  </div>
                </div>
              </div>
            </div>
          </InkCard>

          <InkCard>
            <div className="mb-6">
              <div className="flex items-start gap-4">
                <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 p-3">
                  <Code className="h-6 w-6 text-neutral-300" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-neutral-100">
                    MCP configuration
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-neutral-400">
                    Click Sign to get MCP config, approve the challenge in your wallet, then paste
                    the configuration into your AI agent&apos;s MCP settings. The token is bound
                    to your wallet and requires no local secrets.
                  </p>
                </div>
              </div>
            </div>

            {wallet && <McpConnectionCard wallet={wallet} />}
          </InkCard>

          <InkCard>
            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 p-3">
                  <LinkIcon className="h-6 w-6 text-neutral-300" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-neutral-100">
                    How it works
                  </h2>
                  <div className="mt-4 space-y-3 text-sm leading-6 text-neutral-400">
                    <div className="flex gap-3">
                      <span className="font-semibold text-neutral-300">1.</span>
                      <p>
                        Your AI agent uses the MCP configuration to call the remote SoFinance API
                        at <code className="rounded bg-neutral-800 px-1.5 py-0.5">/api/mcp</code> over
                        HTTPS (12 tools, including quote/prepare/submit_open_position). No local RPC or API keys needed.
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <span className="font-semibold text-neutral-300">2.</span>
                      <p>
                        When the agent prepares a transaction, it returns an unsigned transaction
                        and a <code className="rounded bg-neutral-800 px-1.5 py-0.5">signUrl</code> deep link.
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <span className="font-semibold text-neutral-300">3.</span>
                      <p>
                        Open the <code className="rounded bg-neutral-800 px-1.5 py-0.5">signUrl</code> in
                        your browser with your wallet connected. Review the transaction details and
                        sign with one click.
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <span className="font-semibold text-neutral-300">4.</span>
                      <p>
                        The signed transaction is automatically submitted and verified. Your private
                        keys never leave your wallet.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-blue-900/40 bg-blue-950/20 p-4 text-sm leading-6 text-neutral-400">
                <strong className="text-blue-300">Security note:</strong> The MCP server never
                sees or holds your private keys. Transaction signing happens locally in your
                wallet. The access token only allows reading positions and preparing unsigned
                transactions for your wallet address.
              </div>
            </div>
          </InkCard>
        </div>
      )}
    </InkShell>
  );
}
