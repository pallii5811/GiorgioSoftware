#!/bin/bash
# poll angela rerun log until done
for i in $(seq 1 40); do
  if grep -q 'GOT_EXPIRED=' /tmp/angela-rerun.log 2>/dev/null && grep -q 'FINAL_ACTIVE=' /tmp/angela-rerun.log 2>/dev/null; then
    echo DONE
    tail -80 /tmp/angela-rerun.log
    exit 0
  fi
  echo waiting_$i
  tail -5 /tmp/angela-rerun.log 2>/dev/null || true
  sleep 20
done
echo TIMEOUT
tail -60 /tmp/angela-rerun.log
exit 1
