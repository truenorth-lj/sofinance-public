import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { generateMcpToken } from "@/lib/mcp-auth";

/**
 * POST /api/mcp-token
 * 
 * Generate a short-lived MCP auth token for a wallet.
 * 
 * Request body:
 * {
 *   "wallet": "base58-public-key"
 * }
 * 
 * Response:
 * {
 *   "token": "signed-token",
 *   "wallet": "wallet-address",
 *   "expiresAt": 1234567890000,
 *   "mcpConfig": {
 *     "mcpServers": {
 *       "sofinance": {
 *         "url": "https://sofinance-alpha.vercel.app/api/mcp",
 *         "headers": {
 *           "Authorization": "Bearer <token>"
 *         }
 *       }
 *     }
 *   }
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet } = body;

    if (!wallet || typeof wallet !== "string") {
      return NextResponse.json(
        { error: "Wallet address is required" },
        { status: 400 }
      );
    }

    try {
      new PublicKey(wallet);
    } catch {
      return NextResponse.json(
        { error: "Invalid wallet address" },
        { status: 400 }
      );
    }

    const secret = process.env.JUPITER_API_KEY;
    if (!secret) {
      return NextResponse.json(
        { error: "Server configuration error: JUPITER_API_KEY not set" },
        { status: 500 }
      );
    }

    const ttlMs = 24 * 60 * 60 * 1000; // 24 hours
    const token = generateMcpToken(wallet, secret, ttlMs);
    const expiresAt = Date.now() + ttlMs;

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.VERCEL_URL ||
      "https://sofinance-alpha.vercel.app";

    const normalizedAppUrl = appUrl.startsWith("http")
      ? appUrl
      : `https://${appUrl}`;

    const mcpConfig = {
      mcpServers: {
        sofinance: {
          url: `${normalizedAppUrl}/api/mcp`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    };

    return NextResponse.json({
      token,
      wallet,
      expiresAt,
      expiresAtIso: new Date(expiresAt).toISOString(),
      ttlHours: 24,
      mcpConfig,
      instructions: {
        cursor: "Add the mcpConfig object to your Cursor MCP settings",
        claudeDesktop: "Add the mcpConfig object to ~/Library/Application Support/Claude/claude_desktop_config.json (Mac) or %APPDATA%/Claude/claude_desktop_config.json (Windows)",
        note: "This token authorizes MCP calls for your wallet only. Keep it secure.",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to generate MCP token", details: message },
      { status: 500 }
    );
  }
}
