#!/bin/bash
# Run every functional verify script, record pass/fail by exit code, tail detail.
cd "$(dirname "$0")/.."
rm -rf /tmp/daimond-durability-profile   # memory: durability uses a fixed profile
LOG=/tmp/claude-1000/-home-jason-usr/585c8821-05c0-46df-a9d3-d607765f3c58/scratchpad/suite.log
: > "$LOG"
pass=0; fail=0; failed=""
for f in dev/verify_*.mjs; do
  name=$(basename "$f" .mjs)
  [ "$name" = "verify_durability" ] && rm -rf /tmp/daimond-durability-profile
  out=$(timeout 180 node "$f" 2>&1)
  code=$?
  tail=$(echo "$out" | grep -vE "Skipping host" | tail -1)
  if [ $code -eq 0 ]; then pass=$((pass+1)); echo "PASS  $name  — $tail" | tee -a "$LOG"
  else fail=$((fail+1)); failed="$failed $name"; echo "FAIL  $name (exit $code)  — $tail" | tee -a "$LOG"
  fi
done
echo "" | tee -a "$LOG"
echo "SUITE: $pass passed, $fail failed.  Failed:$failed" | tee -a "$LOG"
