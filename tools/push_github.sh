#!/bin/bash
# Sync source to GitHub WQQZachery/wqzachery.dpdns.org- (run with github credentials; uses curl on api.github.com, works for files >100 KB). Never pushes worker/.admin_key.
cd "$(dirname "$0")/.."
OWNER=WQQZachery; REPO='wqzachery.dpdns.org-'; MSG=${1:-"sync site source"}
put(){ local src=$1 dst=$2 U="https://api.github.com/repos/$OWNER/$REPO/contents/$2"
  sha=$(curl -s "$U" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('sha',''))
except Exception: print('')")
  python3 -c "import sys,json,base64;d={'message':sys.argv[2],'content':base64.b64encode(open(sys.argv[1],'rb').read()).decode()}
if sys.argv[3]: d['sha']=sys.argv[3]
json.dump(d,open('/tmp/gh_put.json','w'))" "$src" "$MSG" "$sha"
  curl -s -X PUT "$U" --data @/tmp/gh_put.json | python3 -c "import sys,json;d=json.load(sys.stdin);print('$dst', 'ok' if d.get('content') else d)"
}
put tools/README.repo.md README.md
put repo/LICENSE LICENSE
for f in app index drive ai chat admin privacy 404; do put site/$f.html site/$f.html; done
put site/shared.css site/shared.css
put site/shared.js site/shared.js
put site/og.png site/og.png
for f in wrangler.jsonc package.json package-lock.json .gitignore; do put $f $f; done
for f in favicon.svg favicon.ico apple-touch-icon.png; do put site/$f site/$f; done
put worker/worker.js worker/worker.js
put deploy/deploy_worker.sh deploy/deploy_worker.sh
for t in lproxy.py scroll_perf.py bar_refr.py lens_sharp.py lens_drag_test.py orb_shots.py page_shots.py sec_test.py unit_test.mjs ui_check.py mobile_check.py link_check.py chat_test.py a11y_check.py stage_deploy.sh routes_check.sh push_github.sh mock_api.py syntax_check.py ai_persist_test.py drive_test.py tab_test.py boot_timing.py favicon_check.py contrast_check.py make_icons.py embed_icons.py build_worker.sh; do put tools/$t tools/$t; done
