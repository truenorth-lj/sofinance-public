#!/usr/bin/env bash
# Hermeticity check: the whole suite must pass with every config/secret env var UNSET and again with
# all of them SET to dummy values (a developer shell or CI runner may have either). Dummy values only;
# nothing here is a real credential and no test may reach the network.
set -euo pipefail
cd "$(dirname "$0")/.."

NAMES=(JUPITER_API_KEY SOLAMI_API_KEY SOLAMI_DATA_API_KEY SOLANA_RPC_URL NEXT_PUBLIC_SOLANA_RPC_URL SOFINANCE_FEE_WALLET
  SOFINANCE_FEE_BPS SOFINANCE_MCP_TOKEN SOFINANCE_MCP_URL NEXT_PUBLIC_APP_URL VERCEL_URL NEXT_PUBLIC_REOWN_PROJECT_ID
  SOFINANCE_RPC_LOG SOFINANCE_JUPITER_LOG SOLAMI_BEAM E2E_KEYLESS_JUPITER SOFINANCE_POSITION_HISTORY_DB_ENABLED)

echo "== all config/secret env vars unset"
env $(printf -- '-u %s ' "${NAMES[@]}") npx vitest run

echo "== all config/secret env vars set to dummy values"
env \
  JUPITER_API_KEY=dummy-jupiter-key SOLAMI_API_KEY=dummy-solami-key SOLAMI_DATA_API_KEY=dummy-solami-data-key \
  SOLANA_RPC_URL=https://rpc.invalid.example/dummy NEXT_PUBLIC_SOLANA_RPC_URL=https://rpc.invalid.example/public \
  SOFINANCE_FEE_WALLET=SynthTestWa11et1111111111111111111111111111 SOFINANCE_FEE_BPS=50 \
  SOFINANCE_MCP_TOKEN=dummy-mcp-token SOFINANCE_MCP_URL=https://mcp.invalid.example NEXT_PUBLIC_APP_URL=https://app.invalid.example \
  VERCEL_URL=app.invalid.example NEXT_PUBLIC_REOWN_PROJECT_ID=dummy-project SOFINANCE_RPC_LOG=1 SOFINANCE_JUPITER_LOG=1 \
  SOLAMI_BEAM=1 E2E_KEYLESS_JUPITER=1 SOFINANCE_POSITION_HISTORY_DB_ENABLED=true \
  npx vitest run
