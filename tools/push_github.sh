#!/bin/bash
# Sync source to GitHub WQQZachery/wqzachery.dpdns.org- (run with github credentials). Never pushes worker/.admin_key.
cd "$(dirname "$0")/.."
OWNER=WQQZachery; REPO='wqzachery.dpdns.org-'; MSG=${1:-"sync site source"}
put(){ local src=$1 dst=$2
  sha=$(apicall github contents_get owner=$OWNER repo=$REPO path="$dst" 2>/dev/null | python3 -c "import sys,json
try:
  d=json.load(sys.stdin);d=d.get('data',d);print(d.get('sha',''))
except Exception: print('')")
  b64=$(base64 -w0 "$src")
  if [ -n "$sha" ]; then r=$(apicall github contents_put owner=$OWNER repo=$REPO path="$dst" message="$MSG" content="$b64" sha="$sha"); else r=$(apicall github contents_put owner=$OWNER repo=$REPO path="$dst" message="$MSG" content="$b64"); fi
  echo "$r" | python3 -c "import sys,json;d=json.load(sys.stdin);d=d.get('data',d);print('$dst', 'ok' if d.get('content') else d)"
}
put tools/README.repo.md README.md
put repo/LICENSE LICENSE
for f in app index drive ai chat admin privacy 404; do put site/$f.html site/$f.html; done
put site/shared.css site/shared.css
put site/shared.js site/shared.js
for f in favicon.svg favicon.ico apple-touch-icon.png; do put site/$f site/$f; done
put worker/worker.js worker/worker.js
put deploy/deploy_worker.sh deploy/deploy_worker.sh
for t in lproxy.py scroll_perf.py bar_refr.py lens_sharp.py lens_drag_test.py orb_shots.py page_shots.py sec_test.py unit_test.mjs ui_check.py mobile_check.py link_check.py chat_test.py a11y_check.py stage_deploy.sh routes_check.sh push_github.sh mock_api.py syntax_check.py ai_persist_test.py drive_test.py tab_test.py boot_timing.py favicon_check.py contrast_check.py make_icons.py embed_icons.py; do put tools/$t tools/$t; done
