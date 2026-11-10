#!/usr/bin/env bash
# Phase B on a test compose stack: a `compose restart` shows every conversation sleeping, and Wake
# through the dashboard API brings one back (fake claude). Needs docker (or CCDASH_DOCKER, e.g.
# "sudo -n -u ccdash /usr/local/bin/ccdash-docker"), curl and jq. Uses its own project and volumes
# (ccdashtest-b) and removes them at the end. Env: CCDASH_TEST_PORT (7691), CCDASH_IMAGE (ccdash:ci,
# built from the checkout if missing; remove it to pick up changes), KEEP=1 (leave the stack up), DEBUG=1.
# shellcheck disable=SC2329,SC1091 # functions run through until_ok / trap; .env.example is a plain env file
set -euo pipefail
# shellcheck source=tests/stack/lib-login.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib-login.sh"
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
D=${CCDASH_DOCKER:-docker} # may contain spaces; left unquoted on purpose
export CCDASH_TEST_PORT=${CCDASH_TEST_PORT:-7691}
base=${CCDASH_IMAGE:-ccdash:ci}
P=ccdashtest-b
export CCDASH_TEST_IMAGE=ccdash-stack:$P
url=http://127.0.0.1:$CCDASH_TEST_PORT
jar=$(mktemp)
fail=0
# The compose file goes in on stdin and the working directory is /, so a Docker user that cannot
# read the checkout still works.
compose() { (cd / && $D compose -p "$P" -f - "$@" < <(sed -e "s|@IMAGE@|$CCDASH_TEST_IMAGE|" -e "s|@PORT@|$CCDASH_TEST_PORT|" -e '/# phase-c$/d' "$root/tests/stack/compose.yaml")); }
ccd() { compose exec -T -u ccd ccdash "$@"; }
cleanup() { [ -n "${KEEP:-}" ] && return; compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -f "$jar"; }
trap cleanup EXIT
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
until_ok() { # until_ok SECONDS DESCRIPTION CMD...
  local n=$1 what=$2; shift 2
  for _ in $(seq $((n * 5))); do if "$@" >/dev/null 2>&1; then ok "$what"; return 0; fi; sleep 0.2; done
  bad "$what (timed out after ${n}s)"
  if [ -n "${DEBUG:-}" ]; then states_brief || true; ccd tmux -S /run/ccdash/tmux.sock list-panes -a -F '#{session_name} #{pane_id} #{pane_pid}' || true; compose logs --tail 20 || true; fi
  return 1
}
tar_ctx() { (cd "$root" && git ls-files -co --exclude-standard -- . ':!dashboard/node_modules' | grep -v '^docs/handoff\|^\.claude' | tar -c -T -); }

if ! $D image inspect "$base" >/dev/null 2>&1; then
  set -a; . "$root/.env.example"; set +a
  tar_ctx | $D build -t "$base" --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" --build-arg "S6_OVERLAY_VERSION=$S6_OVERLAY_VERSION" --build-arg "BASIC_MEMORY_VERSION=$BASIC_MEMORY_VERSION" --build-arg "KIT_REPO=$KIT_REPO" --build-arg "KIT_REF=$KIT_REF" - >/dev/null
fi
tar_ctx | $D build -f tests/Dockerfile.stack --build-arg "BASE=$base" -t "$CCDASH_TEST_IMAGE" - >/dev/null

compose up -d >/dev/null
healthy() { curl -sf "$url/healthz"; }
until_ok 60 "dashboard answers /healthz" healthy

compose exec -T -u web ccdash node -e "require('/opt/ccdash/dashboard/lib/authstore').setCredentials({dir:'/var/lib/ccdash-web',username:'t',password:'test-password-123'})"
login() { curl -sf -c "$jar" -H "Origin: http://localhost:7690" -H 'X-CCDash: 1' -H 'content-type: application/json' \
  -d '{"username":"t","password":"test-password-123"}' "$url/login"; }
until_ok 20 "login" login
api() { curl -sf -b "$jar" -H "Origin: http://localhost:7690" -H 'X-CCDash: 1' "$@"; }
states_brief() { stack_states | jq -c '[.[] | {sid, status}]'; }

for p in demo1 demo2; do
  compose exec -T -u ccd ccdash mkdir -p /workspace/$p
  stack_login "$p"
  ccd ccd-session start $p >/dev/null
done
two_waiting() { [ "$(states_brief | jq '[.[] | select(.status == "waiting")] | length')" = 2 ]; }
until_ok 30 "two conversations are waiting" two_waiting
before=$(states_brief | jq -r '.[0].sid')

compose restart ccdash >/dev/null
until_ok 60 "dashboard back after the restart" healthy
login >/dev/null
all_sleeping() { [ "$(states_brief | jq '[.[] | select(.status == "sleeping")] | length')" = 2 ]; }
until_ok 20 "every conversation is sleeping after compose restart" all_sleeping

# Wake through the API: the old record is replaced by the resumed one
if api -X POST -H 'content-type: application/json' -d '{}' "$url/api/conversations/$before/wake" | jq -e .ok >/dev/null; then ok "wake accepted"; else bad "wake"; fi
woke() { [ "$(states_brief | jq --arg s "$before" '[.[] | select(.status == "waiting")] | length == 1 and ([.[] | select(.sid == $s)] | length) == 0')" = true ]; }
until_ok 15 "woken conversation is waiting and its old record is gone from the tree" woke
args=$(ccd cat /home/ccd/.fake-claude/args.log)
if grep -q -- "--resume $before" <<<"$args"; then ok "claude was started with --resume $before"; else bad "no --resume $before in: $args"; fi
exit $fail
