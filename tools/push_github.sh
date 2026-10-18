#!/bin/bash
# Sync source to GitHub WQQZachery/wqzachery.dpdns.org- as ONE commit via tools/push_github.py. Needs GITHUB_TOKEN in the environment (see push_github.py).
# BRANCH=<name> pushes to that branch (created from main if missing); default main = PRODUCTION (each commit to main triggers one Workers Build). Never pushes worker/.admin_key.
cd "$(dirname "$0")/.."
OWNER=WQQZachery; REPO='wqzachery.dpdns.org-'; MSG=${1:-"sync site source"}
L=(); put(){ L+=("$1:$2"); }
put tools/README.repo.md README.md
put repo/LICENSE LICENSE
for f in app index drive ai chat admin privacy 404; do put site/$f.html site/$f.html; done
put site/shared.css site/shared.css
put site/shared.js site/shared.js
put site/og.png site/og.png
put site/announcements.json site/announcements.json
for f in wrangler.jsonc package.json package-lock.json .gitignore; do put $f $f; done
for f in favicon.svg favicon.ico apple-touch-icon.png; do put site/$f site/$f; done
put worker/worker.js worker/worker.js
put deploy/deploy_worker.sh deploy/deploy_worker.sh
for t in lproxy.py scroll_perf.py bar_refr.py lens_sharp.py lens_drag_test.py orb_shots.py page_shots.py sec_test.py unit_test.mjs ui_check.py mobile_check.py link_check.py chat_test.py a11y_check.py stage_deploy.sh routes_check.sh push_github.sh mock_api.py syntax_check.py ai_persist_test.py drive_test.py tab_test.py boot_timing.py favicon_check.py contrast_check.py make_icons.py embed_icons.py build_worker.sh push_github.py ann_test.py push_github_test.py worker_test.mjs; do put tools/$t tools/$t; done
put .github/workflows/ci.yml .github/workflows/ci.yml
BR=${BRANCH:-main}
if [ "$BR" = main ]; then python3 tools/push_github.py --branch main "$MSG" "${L[@]}"; else python3 tools/push_github.py --branch "$BR" --create-from main "$MSG" "${L[@]}"; fi
