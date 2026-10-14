#!/bin/bash
# Usage: [MIGRATE=1] HF_REPO=wqzachery/drive deploy_worker.sh <script-name>   (auth injected by the 'cloudflare' service)
set -e
N=${1:-wqzachery}; A=2bf233f73b71c343852e1bc2b2d1f190; D=$(cd "$(dirname "$0")/.." && pwd)
MIG=""; [ "$MIGRATE" = "1" ] && MIG=',"migrations":{"new_tag":"v1","new_sqlite_classes":["Store"]}'
META='{"main_module":"worker.js","compatibility_date":"2026-10-01","keep_bindings":["secret_text"]'"$MIG"',"bindings":[
{"type":"ai","name":"AI"},
{"type":"durable_object_namespace","name":"STORE","class_name":"Store"},
{"type":"plain_text","name":"AI_MODELS","text":"@cf/openai/gpt-oss-120b,@cf/meta/llama-3.3-70b-instruct-fp8-fast"},
{"type":"plain_text","name":"GEMINI_MODELS","text":"'"${GEMINI_MODELS:-}"'"},
{"type":"plain_text","name":"HF_REPO","text":"'"${HF_REPO:-wqzachery/drive}"'"},
{"type":"plain_text","name":"CAP_LABEL","text":"100 GB"},
{"type":"ratelimit","name":"CHAT_RL","namespace_id":"7101","simple":{"limit":15,"period":60}},
{"type":"ratelimit","name":"UP_RL","namespace_id":"7102","simple":{"limit":30,"period":60}}]}'
curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$A/workers/scripts/$N" \
 -F "metadata=$META;type=application/json" \
 -F "worker.js=@$D/worker/worker.js;type=application/javascript+module" \
 -F "index.html=@$D/site/index.html;type=text/plain" \
 -F "drive.html=@$D/site/drive.html;type=text/plain" \
 -F "admin.html=@$D/site/admin.html;type=text/plain" \
 -F "404.html=@$D/site/404.html;type=text/plain" \
 -F "app.html=@$D/site/app.html;type=text/plain" \
 -F "ai.html=@$D/site/ai.html;type=text/plain" | python3 -c "import sys,json;d=json.load(sys.stdin);print('success',d['success'],d.get('errors'))"
