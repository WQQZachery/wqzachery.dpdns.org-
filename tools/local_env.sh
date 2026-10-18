#!/bin/bash
# Start/stop the local disposable test environment (tools/local_env.mjs). Usage: tools/local_env.sh start|stop  [env: UP_DAY_FILES=… etc.]
# Needs Miniflare 4 in /tmp/mf4 (see local_env.mjs header). Builds dist/ first. Logs: /tmp/local_env.log
cd "$(dirname "$0")/.."
PIDF=/tmp/local_env.pid
stop() { [ -f $PIDF ] && { kill "$(cat $PIDF)" 2>/dev/null; rm -f $PIDF; sleep 2; }; }
case "$1" in
  stop) stop ;;
  start) stop; bash tools/build_worker.sh >/dev/null || exit 1
    MINIFLARE=${MINIFLARE:-/tmp/mf4/node_modules/miniflare/dist/src/index.js} setsid node tools/local_env.mjs > /tmp/local_env.log 2>&1 & echo $! > $PIDF
    for i in $(seq 1 40); do grep -q "local env ready" /tmp/local_env.log 2>/dev/null && { tail -1 /tmp/local_env.log; exit 0; }; sleep 0.5; done
    echo "local env failed to start:"; tail -20 /tmp/local_env.log; exit 1 ;;
  *) echo "usage: $0 start|stop"; exit 2 ;;
esac
