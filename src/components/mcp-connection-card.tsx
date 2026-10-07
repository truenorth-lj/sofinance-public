"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Copy, Check, Code, ExternalLink } from "lucide-react";

interface McpConnectionCardProps {
  wallet: string;
}

export function McpConnectionCard({ wallet }: McpConnectionCardProps) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const generateToken = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch("/api/mcp-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to generate token");
      }

      const data = await response.json();
      setToken(data.token);
      setExpiresAt(data.expiresAt);
      setNow(Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    let mounted = true;
    const run = async () => {
      if (mounted) {
        await generateToken();
      }
    };
    void run();
    return () => {
      mounted = false;
    };
  }, [generateToken]);

  const mcpConfig = useMemo(() => {
    if (!token) return null;

    const appUrl =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://sofinance-alpha.vercel.app";

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
  }, [token]);

  const configJson = useMemo(
    () => (mcpConfig ? JSON.stringify(mcpConfig, null, 2) : ""),
    [mcpConfig]
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

  if (loading) {
    return (
      <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/50 p-4">
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <Code className="h-4 w-4 animate-pulse" />
          Generating MCP connection token...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-neutral-700 bg-neutral-900/50 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-neutral-400">
            Failed to generate MCP token: {error}
          </div>
          <button
            onClick={() => void generateToken()}
            className="text-xs font-semibold text-neutral-300 underline hover:text-neutral-100"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!token) {
    return null;
  }

  return (
    <details className="rounded-xl border border-neutral-800/80 bg-neutral-900/50">
      <summary className="cursor-pointer p-4 text-sm font-semibold text-neutral-300 hover:text-neutral-100">
        <Code className="mr-2 inline h-4 w-4" />
        MCP Connection (AI Agents)
      </summary>

      <div className="space-y-4 border-t border-neutral-800/60 p-4">
        <p className="text-xs leading-5 text-neutral-500">
          Use this configuration to access SoFinance from AI agents like Cursor
          or Claude Desktop. The token is bound to your wallet and expires in{" "}
          <strong className="text-neutral-300">{expiresIn} hours</strong>.
        </p>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Cursor Configuration
            </span>
            <button
              onClick={() => copyToClipboard(configJson)}
              className="flex items-center gap-1.5 text-xs font-semibold text-neutral-400 transition-colors hover:text-neutral-200"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy config
                </>
              )}
            </button>
          </div>

          <pre className="overflow-x-auto rounded-lg border border-neutral-800/60 bg-neutral-950 p-3 text-[11px] leading-5">
            <code className="text-neutral-300">{configJson}</code>
          </pre>
        </div>

        <div className="space-y-2 rounded-lg border border-neutral-800/40 bg-neutral-900/30 p-3 text-xs leading-5">
          <div className="font-semibold text-neutral-300">How to use:</div>
          <ol className="ml-4 list-decimal space-y-1 text-neutral-500">
            <li>
              <strong className="text-neutral-400">Cursor:</strong> Open MCP
              settings and paste the config above
            </li>
            <li>
              <strong className="text-neutral-400">Claude Desktop:</strong> Add
              to{" "}
              <code className="rounded bg-neutral-800 px-1 py-0.5 text-neutral-300">
                claude_desktop_config.json
              </code>
            </li>
            <li className="text-neutral-400">
              Tools available: list_positions, quote_add_liquidity,
              prepare_transaction, submit_signed_transaction, quote_compound,
              prepare_compound_transaction, submit_compound_transaction,
              list_rwa_pairs, get_position_performance
            </li>
          </ol>
        </div>

        <div className="flex items-center justify-between border-t border-neutral-800/40 pt-3 text-xs">
          <span className="text-neutral-500">
            Server never holds your private keys. Signing happens locally.
          </span>
          <a
            href="https://github.com/truenorth-lj/sofinance-public#mcp-tools-9"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 font-semibold text-neutral-400 transition-colors hover:text-neutral-200"
          >
            Docs
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </details>
  );
}
