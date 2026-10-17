#!/bin/bash
# Build the Worker bundle for wrangler / Cloudflare Workers Builds: copies worker/worker.js + the site files it imports into dist/ (flat).
# Same module set as deploy/deploy_worker.sh. Never copies worker/.admin_key.
set -e; cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
cp worker/worker.js dist/
for f in index drive admin 404 app ai chat privacy; do cp "site/$f.html" dist/; done
cp site/shared.css site/shared.js site/og.png dist/
echo "dist/: $(ls dist | tr '\n' ' ')"
