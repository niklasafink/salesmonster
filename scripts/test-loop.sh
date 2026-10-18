#!/bin/zsh
# Runs the Playwright suite against production every INTERVAL seconds for HOURS hours; log in test-logs/loop.log
cd "$(dirname "$0")/.."
INTERVAL=${INTERVAL:-600}; HOURS=${HOURS:-6}
end=$(( $(date +%s) + HOURS * 3600 )); mkdir -p test-logs/runs
while [ $(date +%s) -lt $end ]; do
  ts=$(date +%Y-%m-%d_%H-%M)
  npx playwright test --reporter=line --output=test-logs/out > "test-logs/runs/$ts.log" 2>&1
  code=$?
  echo "$ts exit=$code $(grep -Eo '[0-9]+ (passed|failed|flaky)' test-logs/runs/$ts.log | tr '\n' ' ')" >> test-logs/loop.log
  [ $code -ne 0 ] && cp test-logs/runs/$ts.log "test-logs/runs/FAIL-$ts.log"
  sleep $INTERVAL
done
