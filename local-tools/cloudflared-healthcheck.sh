#!/bin/bash
# Restart cloudflared when the origin is healthy but Cloudflare edge
# returns 530 / error 1033 (live process, dead QUIC). Does not restart
# the coordinator app; local 200 + public 530 is the only trigger.
#
# Two consecutive 530/1033 ticks are required before restarting, so a
# Modern Standby resume (cloudflared re-registers in ~12s, Persistent=true
# fires immediately) does not bounce a tunnel that is already recovering.
set -u
LOCAL_URL="${COORDINATOR_LOCAL_HEALTH:-http://127.0.0.1:3335/health}"
PUBLIC_URL="${COORDINATOR_PUBLIC_HEALTH:-https://coordinator.lahadyekutiel.com/health}"
STAMP="${CLOUDFLARED_HEALTHCHECK_STAMP:-/run/cloudflared-healthcheck.last-restart}"
FAILS="${CLOUDFLARED_HEALTHCHECK_FAILS:-/run/cloudflared-healthcheck.consecutive-fails}"
MIN_INTERVAL="${CLOUDFLARED_HEALTHCHECK_MIN_INTERVAL:-120}"
CONSECUTIVE_NEEDED="${CLOUDFLARED_HEALTHCHECK_CONSECUTIVE:-2}"
LOCK="${CLOUDFLARED_HEALTHCHECK_LOCK:-/run/cloudflared-healthcheck.lock}"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "skip: another healthcheck is running"
  exit 0
fi

reset_fails() {
  rm -f "$FAILS"
}

if ! systemctl is-active --quiet cloudflared.service; then
  echo "cloudflared is not active; starting"
  systemctl start cloudflared.service
  date +%s >"$STAMP"
  reset_fails
  exit 0
fi

local_code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "$LOCAL_URL" || true)
if [ -z "$local_code" ]; then
  local_code="000"
fi
if [ "$local_code" != "200" ]; then
  echo "skip: local health ${local_code} (origin down — not a tunnel-only failure)"
  exit 0
fi

body=$(mktemp)
public_code=$(curl -sS -o "$body" -w "%{http_code}" --max-time 15 "$PUBLIC_URL" || true)
if [ -z "$public_code" ]; then
  public_code="000"
fi
has_1033=0
if grep -q "error code: 1033" "$body" 2>/dev/null; then
  has_1033=1
fi
rm -f "$body"

if [ "$public_code" = "200" ] && [ "$has_1033" -eq 0 ]; then
  reset_fails
  echo "ok: local=200 public=200"
  exit 0
fi

if [ "$public_code" != "530" ] && [ "$has_1033" -eq 0 ]; then
  echo "skip: public=${public_code} (not 530/1033); not restarting"
  exit 0
fi

fail_count=0
if [ -f "$FAILS" ]; then
  fail_count=$(cat "$FAILS" 2>/dev/null || echo 0)
fi
fail_count=$((fail_count + 1))
echo "$fail_count" >"$FAILS"

if [ "$fail_count" -lt "$CONSECUTIVE_NEEDED" ]; then
  echo "defer: 530/1033 consecutive=${fail_count}/${CONSECUTIVE_NEEDED} (need ${CONSECUTIVE_NEEDED} ticks before restart)"
  exit 0
fi

now=$(date +%s)
if [ -f "$STAMP" ]; then
  last=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ "$((now - last))" -lt "$MIN_INTERVAL" ]; then
    echo "skip: 530/1033 consecutive=${fail_count} but last restart $((now - last))s ago (min ${MIN_INTERVAL}s)"
    exit 0
  fi
fi

echo "restarting cloudflared: local=200 public=${public_code} error1033=${has_1033} consecutive=${fail_count} min_interval=${MIN_INTERVAL}s"
date +%s >"$STAMP"
reset_fails
systemctl restart cloudflared.service
