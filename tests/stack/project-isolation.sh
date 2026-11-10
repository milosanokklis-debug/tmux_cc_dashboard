#!/usr/bin/env bash
# Per-project isolation on a test compose stack, inside the real image: two projects (a, b), only a signed in
# through the fake claude. AC-5.1 `ccd-session auth` says a is logged-in and b logged-out; AC-5.2 the web user
# cannot read a's config dir and neither the sign-in URL nor the code is stored under /var/lib/ccdash-web;
# AC-5.3 a shell window of b runs with CLAUDE_CONFIG_DIR set to b's dir; AC-5.4 the windows API (list, new
# shell, close) for a leaves b's window list untouched. Needs docker (or CCDASH_DOCKER), curl, jq and tar.
# Own project and volumes (ccdashtest-iso), removed at the end.
# Env: CCDASH_TEST_PORT (7698), CCDASH_IMAGE (ccdash:ci, built from the checkout if missing or older than the
# tree; the staleness check is skipped when CI is set, the workflow builds it just before), KEEP=1, DEBUG=1.
# shellcheck disable=SC2329,SC1091 # functions run through until_ok / trap; .env.example is a plain env file
set -euo pipefail
# shellcheck source=tests/stack/lib-login.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib-login.sh"
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
D=${CCDASH_DOCKER:-docker} # may contain spaces; left unquoted on purpose
export CCDASH_TEST_PORT=${CCDASH_TEST_PORT:-7698}
base=${CCDASH_IMAGE:-ccdash:ci}
P=ccdashtest-iso
export CCDASH_TEST_IMAGE=ccdash-stack:$P
url=http://127.0.0.1:$CCDASH_TEST_PORT
origin=http://localhost:7690
tmp=$(mktemp -d)
jar=$tmp/jar
fail=0

compose() { (cd / && $D compose -p "$P" -f - "$@" < <(sed -e "s|@IMAGE@|$CCDASH_TEST_IMAGE|" -e "s|@PORT@|$CCDASH_TEST_PORT|" -e '/# phase-c$/d' "$root/tests/stack/compose.yaml")); }
ccd() { compose exec -T -u ccd ccdash "$@"; }
tm() { ccd tmux -S /run/ccdash/tmux.sock "$@"; }
cleanup() {
  if [ -z "${KEEP:-}" ]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
until_ok() { # until_ok SECONDS DESCRIPTION CMD...
  local n=$1 what=$2; shift 2
  for _ in $(seq $((n * 5))); do if "$@" >/dev/null 2>&1; then ok "$what"; return 0; fi; sleep 0.2; done
  bad "$what (timed out after ${n}s)"
  if [ -n "${DEBUG:-}" ]; then compose logs --tail 30 || true; fi
  return 1
}
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
tar_ctx() { (cd "$root" && git ls-files -co --exclude-standard -- . ':!dashboard/node_modules' | grep -v '^docs/handoff\|^\.claude' | tar -c -T -); }

# ---------------------------------------------------------------- images
stale=""
if [ -z "${CI:-}" ] && $D image inspect "$base" >/dev/null 2>&1; then
  built=$(date -d "$($D image inspect -f '{{.Created}}' "$base")" +%s)
  newest=$(cd "$root" && git ls-files -co --exclude-standard -- . ':!dashboard/node_modules' | grep -v '^docs/handoff\|^\.claude' | xargs -d '\n' stat -c %Y 2>/dev/null | sort -n | tail -n 1)
  [ "${newest:-0}" -le "$built" ] || stale=1
fi
if [ -n "$stale" ] || ! $D image inspect "$base" >/dev/null 2>&1; then
  set -a; . "$root/.env.example"; set +a
  tar_ctx | $D build -q -t "$base" --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" --build-arg "S6_OVERLAY_VERSION=$S6_OVERLAY_VERSION" --build-arg "BASIC_MEMORY_VERSION=$BASIC_MEMORY_VERSION" --build-arg "KIT_REPO=$KIT_REPO" --build-arg "KIT_REF=$KIT_REF" - >/dev/null
fi
tar_ctx | $D build -q -f tests/Dockerfile.stack --build-arg "BASE=$base" -t "$CCDASH_TEST_IMAGE" - >/dev/null

compose down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d >/dev/null
healthy() { curl -sf "$url/healthz"; }
until_ok 60 "dashboard answers /healthz" healthy
compose exec -T -u web ccdash node -e "require('/opt/ccdash/dashboard/lib/authstore').setCredentials({dir:'/var/lib/ccdash-web',username:'t',password:'test-password-123'})"
login() { curl -sf -c "$jar" -H "Origin: $origin" -H 'X-CCDash: 1' -H 'content-type: application/json' \
  -d '{"username":"t","password":"test-password-123"}' "$url/login"; }
until_ok 20 "login" login
api() { curl -sf -b "$jar" -H "Origin: $origin" -H 'X-CCDash: 1' "$@"; }
post() { api -X POST -H 'content-type: application/json' -d "${2:-{\}}" "$url$1"; } # post PATH [JSON]

ccd mkdir -p /workspace/a /workspace/b
stack_login a

echo "== AC-5.1 sign-in state per project"
eq "AC-5.1 a is logged-in" "$(ccd ccd-session auth a)" logged-in
eq "AC-5.1 b is logged-out" "$(ccd ccd-session auth b)" logged-out

echo "== AC-5.2 the web user cannot reach a's credentials"
# The fake marks a project signed in with an empty file, $FAKE_CLAUDE_HOME/accounts/a/logged-in; the config dir
# itself (0700 ccd) is what keeps the web user out of the real claude's .credentials.json.
cd_a=/home/ccd/.claude-projects/a
mode=$(ccd stat -c '%U:%a' "$cd_a")
eq "AC-5.2 a's config dir is ccd 700" "$mode" "ccd:700"
out=$(compose exec -T -u web ccdash cat "$cd_a/.credentials.json" 2>&1 || true)
if grep -q 'Permission denied' <<<"$out"; then ok "AC-5.2 web reading a's credentials file: Permission denied"; else bad "AC-5.2 web reading a's credentials file: $out"; fi
out=$(compose exec -T -u web ccdash ls "$cd_a" 2>&1 || true)
if grep -q 'Permission denied' <<<"$out"; then ok "AC-5.2 web listing a's config dir: Permission denied"; else bad "AC-5.2 web listing a's config dir: $out"; fi
leak=$(compose exec -T -u root ccdash grep -rlE 'claude.com/cai/oauth|code123' /var/lib/ccdash-web 2>/dev/null || true)
if [ -z "$leak" ]; then ok "AC-5.2 no sign-in URL or code under /var/lib/ccdash-web"; else bad "AC-5.2 sign-in URL or code found in: $leak"; fi

echo "== AC-5.3 a shell window of b runs under b's config dir"
shell_id=$(ccd ccd-session new b shell)
pane_env() { # CLAUDE_CONFIG_DIR of the shell window's pane process or any of its children
  local pid
  pid=$(tm list-panes -t "$shell_id" -F '#{pane_pid}' | head -n 1)
  [ -n "$pid" ] || return 1
  ccd sh -c 'for p in "$1" $(pgrep -P "$1"); do tr "\0" "\n" </proc/$p/environ 2>/dev/null | grep "^CLAUDE_CONFIG_DIR="; done | head -n 1' _ "$pid"
}
until_ok 10 "AC-5.3 the shell window's process has CLAUDE_CONFIG_DIR" pane_env
eq "AC-5.3 CLAUDE_CONFIG_DIR is b's dir" "$(pane_env || true)" "CLAUDE_CONFIG_DIR=/home/ccd/.claude-projects/b"

echo "== AC-5.4 windows API for a leaves b alone"
wins() { api "$url/api/projects/$1/windows" | jq -c '[.windows[] | .id] | sort'; }
b_before=$(wins b)
a_before=$(wins a)
new=$(post /api/projects/a/windows '{"kind":"shell"}' | jq -r .id)
if [[ $new =~ ^@[0-9]+$ ]]; then ok "AC-5.4 created shell window $new in a"; else bad "AC-5.4 create returned '$new'"; fi
listed() { wins a | jq -e --arg id "$new" 'index($id) != null'; }
until_ok 10 "AC-5.4 the new window is in a's list" listed
eq "AC-5.4 a's list grew by exactly that window" "$(wins a)" "$(jq -c --arg id "$new" '. + [$id] | sort' <<<"$a_before")"
post "/api/projects/a/windows/$new/close" >/dev/null || bad "AC-5.4 close request failed"
gone() { ! wins a | jq -e --arg id "$new" 'index($id) != null'; }
until_ok 10 "AC-5.4 the window is gone from a's list" gone
eq "AC-5.4 b's window list is unchanged" "$(wins b)" "$b_before"
exit $fail
