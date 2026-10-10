"use client";

import { InkHero, InkShell, InkNav, InkCard } from "@/components/ink";
import { useWalletConnection } from "@/components/wallet-connection";
import { McpConnectionCard } from "@/components/mcp-connection-card";
import { Wallet, Sparkles, Code, Link as LinkIcon } from "lucide-react";

export default function AIManagementPage() {
  const { address: wallet, connected, connect, disconnect } = useWalletConnection();

  return (
    <InkShell maxWidth="5xl">
      <InkNav wallet={wallet} connected={connected} onConnect={connect} onDisconnect={disconnect} />

      <InkHero
        label="Use AI"
        title="Manage positions with AI"
        aside={<Sparkles className="h-5 w-5 text-ink/60" aria-hidden="true" />}
      >
        <p>Connect your wallet to get started with AI-powered position management via MCP</p>
      </InkHero>

      {!connected ? (
        <InkCard className="mt-3">
          <div className="space-y-6">
            <div className="flex items-start gap-4">
              <div className="rounded-lg border border-white/20 bg-white/[0.07] p-3">
                <Wallet className="h-6 w-6 text-cream/80" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-cream">
                  Step 1: Connect your wallet
                </h2>
                  <p className="mt-2 text-sm leading-6 text-smoke">
                    Connect your wallet to start. Connecting only opens a session — you&apos;ll
                    still sign a message in the next step to prove you control the key.
                  </p>
                <button
                  onClick={connect}
                  className="mt-4 inline-flex items-center justify-center gap-2 rounded-full bg-lemon px-5 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f]"
                >
                  <Wallet className="h-4 w-4" />
                  Connect wallet
                </button>
              </div>
            </div>

            <div className="border-t border-white/10 pt-6">
              <div className="flex items-start gap-4 opacity-50">
                <div className="rounded-lg border border-white/20 bg-white/[0.07] p-3">
                  <Code className="h-6 w-6 text-cream/80" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-cream">
                    Step 2: Copy MCP configuration
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-smoke">
                    After connecting, click Sign to get MCP config, approve the wallet prompt,
                    then copy the snippet into your AI agent&apos;s MCP settings.
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t border-white/10 pt-6">
              <div className="flex items-start gap-4 opacity-50">
                <div className="rounded-lg border border-white/20 bg-white/[0.07] p-3">
                  <LinkIcon className="h-6 w-6 text-cream/80" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-cream">
                    Step 3: Start using AI agents
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-smoke">
                    Your AI agent will be able to list positions and RWA pairs, quote add-liquidity /
                    compound / open-position, and prepare unsigned transactions (14 MCP tools). When
                    ready to sign, open the provided link with your wallet connected for one-click approval.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </InkCard>
      ) : (
        <div className="mt-3 space-y-3">
          <InkCard>
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="rounded-lg border border-mint/30 bg-mint/10 p-3">
                  <Wallet className="h-6 w-6 text-mint" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-cream">
                    Wallet connected
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-smoke">
                    Your wallet is connected. Sign below to mint a wallet-bound MCP token — a
                    WalletConnect session alone is not enough.
                  </p>
                  <div className="mt-3 flex items-center gap-2 text-xs">
                    <span className="text-smoke">Address:</span>
                    <code className="rounded bg-white/10 px-2 py-1 font-mono text-cream/80">
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
                <div className="rounded-lg border border-white/20 bg-white/[0.07] p-3">
                  <Code className="h-6 w-6 text-cream/80" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-cream">
                    MCP configuration
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-smoke">
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
                <div className="rounded-lg border border-white/20 bg-white/[0.07] p-3">
                  <LinkIcon className="h-6 w-6 text-cream/80" />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-cream">
                    How it works
                  </h2>
                  <div className="mt-4 space-y-3 text-sm leading-6 text-smoke">
                    <div className="flex gap-3">
                      <span className="font-semibold text-cream/80">1.</span>
                      <p>
                        Your AI agent uses the MCP configuration to call the remote SoFinance API
                        at <code className="rounded bg-white/10 px-1.5 py-0.5">/api/mcp</code> over
                        HTTPS (14 tools, including quote/prepare/submit_open_position plus live Blur pool activity). No local RPC or API keys needed.
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <span className="font-semibold text-cream/80">2.</span>
                      <p>
                        When the agent prepares a transaction, it returns an unsigned transaction
                        and a <code className="rounded bg-white/10 px-1.5 py-0.5">signUrl</code> deep link.
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <span className="font-semibold text-cream/80">3.</span>
                      <p>
                        Open the <code className="rounded bg-white/10 px-1.5 py-0.5">signUrl</code> in
                        your browser with your wallet connected. Review the transaction details and
                        sign with one click.
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <span className="font-semibold text-cream/80">4.</span>
                      <p>
                        The signed transaction is automatically submitted and verified. Your private
                        keys never leave your wallet.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-lilac/30 bg-lilac/10 p-4 text-sm leading-6 text-smoke">
                <strong className="text-lilac">Security note:</strong> The MCP server never
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
