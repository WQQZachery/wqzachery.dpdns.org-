#!/bin/bash
# Stage site/ worker/ deploy/ into build/dep (never copies worker/.admin_key) and deploy: tools/stage_deploy.sh <wqz-test|wqzachery>
set -e; cd "$(dirname "$0")/.."
rm -rf build/dep && mkdir -p build/dep/worker build/dep/site build/dep/deploy
cp site/* build/dep/site/; cp worker/worker.js worker/indexnow.key build/dep/worker/; cp deploy/deploy_worker.sh build/dep/deploy/
HF_REPO=wqzachery/drive build/dep/deploy/deploy_worker.sh "$1"
