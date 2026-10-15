#!/usr/bin/env bash
# Vendor a packed release of @sofinance/engine from sofinance-app-prototype.
#
# Usage (from a prototype checkout at tag engine-vX.Y.Z):
#   pnpm --filter @sofinance/engine pack --pack-destination /tmp
#   ./scripts/update-engine.sh /tmp/sofinance-engine-X.Y.Z.tgz
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p vendor
tarball="${1:?path to sofinance-engine-X.Y.Z.tgz required}"
cp "$tarball" vendor/
name="$(basename "$tarball")"
node -e "const p=require('./package.json');p.dependencies['@sofinance/engine']='file:vendor/${name}';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
pnpm install
pnpm test
pnpm typecheck
pnpm lint
echo "Vendored vendor/${name}. Commit package.json, pnpm-lock.yaml, Dockerfile and vendor/${name}."
