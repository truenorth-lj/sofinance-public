"use client";

import { useState, useCallback, useMemo } from "react";
import { Copy, Check, Code, ExternalLink, ShieldCheck } from "lucide-react";
import { useWalletConnection } from "./wallet-connection";
import bs58 from "bs58";

interface McpConnectionCardProps {
  wallet: string;
}

export function McpConnectionCard({ wallet }: McpConnectionCardProps) {
  const { signMessage } = useWalletConnection();
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [signing, setSigning] = useState(false);

  const generateToken = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setSigning(false);

      // WalletConnect session is not ownership proof — require an explicit ed25519 signature.
      if (!signMessage) {
        setError(
          "Your wallet does not support message signing. Please use a different wallet or connection method."
        );
        setLoading(false);
        return;
      }

      // Step 1: Get challenge from server
      const challengeResponse = await fetch(`/api/mcp-token?wallet=${encodeURIComponent(wallet)}`);
      if (!challengeResponse.ok) {
        const errorData = await challengeResponse.json();
        throw new Error(errorData.error || "Failed to get challenge");
      }

      const challenge = await challengeResponse.json();

      // Step 2: Sign the challenge message
      setSigning(true);
      const messageBytes = new TextEncoder().encode(challenge.message);
      let signatureBytes: Uint8Array;
      
      try {
        signatureBytes = await signMessage(messageBytes);
      } catch (signError) {
        if (signError instanceof Error && signError.message.includes("rejected")) {
          throw new Error("Signature rejected by wallet. Please try again and approve the message.");
        }
        throw signError;
      }

      const signature = bs58.encode(signatureBytes);
      setSigning(false);

      // Step 3: Submit signature to get token
      const tokenResponse = await fetch("/api/mcp-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet,
          message: challenge.message,
          signature,
        }),
      });

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.json();
        throw new Error(errorData.error || "Failed to generate token");
      }

      const data = await tokenResponse.json();
      setToken(data.token);
      setExpiresAt(data.expiresAt);
      setNow(Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
      setSigning(false);
    }
  }, [wallet, signMessage]);

  const appUrl = useMemo(
    () =>
      typeof window !== "undefined"
        ? window.location.origin
        : "https://sofinancelab.xyz",
    []
  );

  const httpConfig = useMemo(() => {
    if (!token) return null;

    return {
      mcpServers: {
        sofinance: {
          url: `${appUrl}/api/mcp`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    };
  }, [token, appUrl]);

  const shimConfig = useMemo(() => {
    if (!token) return null;

    return {
      mcpServers: {
        sofinance: {
          command: "npx",
          args: ["tsx", "src/mcp/remote-shim.ts"],
          cwd: "/absolute/path/to/sofinance-public",
          env: {
            SOFINANCE_MCP_URL: `${appUrl}/api/mcp`,
            SOFINANCE_MCP_TOKEN: token,
          },
        },
      },
    };
  }, [token, appUrl]);

  const httpConfigJson = useMemo(
    () => (httpConfig ? JSON.stringify(httpConfig, null, 2) : ""),
    [httpConfig]
  );

  const shimConfigJson = useMemo(
    () => (shimConfig ? JSON.stringify(shimConfig, null, 2) : ""),
    [shimConfig]
  );

  const expiresIn = useMemo(
    () => (expiresAt ? Math.max(0, Math.floor((expiresAt - now) / 1000 / 60 / 60)) : 0),
    [expiresAt, now]
  );

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail - user can copy manually
    }
  }

  if (loading || signing) {
    return (
      <div className="rounded-2xl border border-white/12 bg-white/[0.04] p-4">
        <div className="flex items-center gap-2 text-sm text-smoke">
          {signing ? (
            <>
              <ShieldCheck className="h-4 w-4 animate-pulse" />
              Please sign the message in your wallet to prove ownership...
            </>
          ) : (
            <>
              <Code className="h-4 w-4 animate-pulse" />
              Generating MCP connection token...
            </>
          )}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-white/20 bg-white/[0.04] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-smoke">
            Failed to generate MCP token: {error}
          </div>
          <button
            type="button"
            onClick={() => void generateToken()}
            className="text-xs font-semibold text-cream/80 underline hover:text-cream"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="rounded-2xl border border-white/12 bg-white/[0.04] p-4">
        <button
          type="button"
          onClick={() => void generateToken()}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-lemon px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-lemon"
        >
          <ShieldCheck className="h-4 w-4" />
          Sign to get MCP config
        </button>
        <p className="mt-3 text-xs leading-5 text-smoke">
          WalletConnect connects the session; signing proves you control the key for the short-lived token.
        </p>
      </div>
    );
  }

  return (
    <details className="rounded-2xl border border-white/12 bg-white/[0.04]">
      <summary className="cursor-pointer p-4 text-sm font-semibold text-cream/80 hover:text-cream">
        <Code className="mr-2 inline h-4 w-4" />
        MCP Connection (AI Agents)
        <span className="ml-2 inline-flex items-center" title="Signature verified">
          <ShieldCheck className="inline h-4 w-4 text-mint" />
        </span>
      </summary>

      <div className="space-y-4 border-t border-white/10 p-4">
        <p className="text-xs leading-5 text-smoke">
          Use this configuration to access SoFinance from AI agents like Cursor
          or Claude Desktop. The token is bound to your wallet and expires in{" "}
          <strong className="text-cream/80">{expiresIn} hours</strong>.
        </p>

        <div className="rounded-lg border border-mint/30 bg-mint/10 p-3 text-xs leading-5 text-smoke">
          <ShieldCheck className="mr-2 inline h-4 w-4 text-mint" />
          This token was issued after verifying your wallet signature. Only you can generate tokens for your wallet.
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-smoke">
                Option A: Direct HTTP (Preferred)
              </span>
              <button
                onClick={() => copyToClipboard(httpConfigJson)}
                className="flex items-center gap-1.5 text-xs font-semibold text-smoke transition-colors hover:text-cream/90"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </>
                )}
              </button>
            </div>
            <p className="mt-1 text-xs text-smoke/70">
              Use if your agent supports HTTP MCP with custom headers
            </p>
            <pre className="mt-2 overflow-x-auto rounded-lg border border-white/10 bg-canvas p-3 text-[11px] leading-5">
              <code className="text-cream/80">{httpConfigJson}</code>
            </pre>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-smoke">
                Option B: Zero-Secret Shim (Fallback)
              </span>
              <button
                onClick={() => copyToClipboard(shimConfigJson)}
                className="flex items-center gap-1.5 text-xs font-semibold text-smoke transition-colors hover:text-cream/90"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </>
                )}
              </button>
            </div>
            <p className="mt-1 text-xs text-smoke/70">
              Use if your agent only supports stdio. Requires: <code className="rounded bg-white/10 px-1">pnpm install</code> + update <code className="rounded bg-white/10 px-1">cwd</code> path
            </p>
            <pre className="mt-2 overflow-x-auto rounded-lg border border-white/10 bg-canvas p-3 text-[11px] leading-5">
              <code className="text-cream/80">{shimConfigJson}</code>
            </pre>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs leading-5">
          <div className="font-semibold text-cream/80">How to use:</div>
          <ol className="ml-4 list-decimal space-y-1 text-smoke">
            <li>
              <strong className="text-smoke">Try Option A first:</strong> Direct HTTP is simpler (no local files needed)
            </li>
            <li>
              <strong className="text-smoke">If that doesn&apos;t work:</strong> Use Option B shim (requires <code className="rounded bg-white/10 px-1">pnpm install</code> in repo)
            </li>
            <li>
              <strong className="text-smoke">Cursor:</strong> Paste into MCP settings
            </li>
            <li>
              <strong className="text-smoke">Claude Desktop:</strong> Add to <code className="rounded bg-white/10 px-1">claude_desktop_config.json</code>
            </li>
            <li className="text-smoke">
              <strong>Tools:</strong> list_positions, quote_add_liquidity,
              prepare_transaction, submit_signed_transaction, quote_compound,
              prepare_compound_transaction, submit_compound_transaction,
              list_rwa_pairs, get_position_performance, quote_open_position,
              prepare_open_position, submit_open_position
            </li>
          </ol>
        </div>

        <div className="flex items-center justify-between border-t border-white/10 pt-3 text-xs">
          <span className="text-smoke">
            Server never holds your private keys. Signing happens locally.
          </span>
          <a
            href="https://github.com/truenorth-lj/sofinance-public#mcp-tools-12"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 font-semibold text-smoke transition-colors hover:text-cream/90"
          >
            Docs
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </details>
  );
}
