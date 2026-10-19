#!/bin/bash
# All public routes must answer 200: tools/routes_check.sh <base>
B=${1:-https://wqz-test.15112479050.workers.dev}; fail=0
for u in / /drive /ai /chat /p/home /p/drive /p/ai /p/chat /privacy /admin /robots.txt /sitemap.xml /llms.txt /og.png /api/models /api/stats /api/limits /shared.css /shared.js /marked.js /announcements.json /api/announcements; do
  c=$(curl -s -o /dev/null -w '%{http_code}' -A 'Mozilla/5.0 routes-check' "$B$u"); [ "$c" = 200 ] || fail=1; echo "$c $u"; done
c=$(curl -s -o /dev/null -w '%{http_code}' "$B/nope-$$"); echo "$c /nope (expect 404)"; [ "$c" = 404 ] || fail=1
exit $fail
