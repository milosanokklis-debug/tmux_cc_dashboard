#!/usr/bin/env bash
# Phase D on a test compose stack: re-onboarding with pull, and the git identity. A local bare repo
# stands in for GitHub (git url.<bare>.insteadOf), so no network and no token are needed. Pull must
# fast-forward a project while its fake Claude keeps running (same pid, pane untouched), refuse a dirty
# tree and a diverged branch, fail cleanly (502, HEAD unchanged) when the remote is unreachable, and the
# identity set through the API must show up as the author of a commit made by ccd. Needs docker (or
# CCDASH_DOCKER, e.g. "sudo -n -u ccdash /usr/local/bin/ccdash-docker"), curl and jq. Own project and
# volumes (ccdashtest-d), removed at the end. Env: CCDASH_TEST_PORT (7693), CCDASH_IMAGE (ccdash:ci, built
# from the checkout if missing; remove it to pick up changes), KEEP=1 (leave the stack up), DEBUG=1.
# shellcheck disable=SC2329,SC1091 # functions run through until_ok / trap; .env.example is a plain env file
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
D=${CCDASH_DOCKER:-docker} # may contain spaces; left unquoted on purpose
export CCDASH_TEST_PORT=${CCDASH_TEST_PORT:-7693}
base=${CCDASH_IMAGE:-ccdash:ci}
P=ccdashtest-d
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
  if [ -n "${DEBUG:-}" ]; then compose logs --tail 20 || true; fi
  return 1
}
check() { # check DESCRIPTION CMD...
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi
}
tar_ctx() { (cd "$root" && git ls-files -co --exclude-standard -- . ':!dashboard/node_modules' | grep -v '^docs/handoff\|^\.claude' | tar -c -T -); }

if ! $D image inspect "$base" >/dev/null 2>&1; then
  set -a; . "$root/.env.example"; set +a
  tar_ctx | $D build -t "$base" --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" --build-arg "S6_OVERLAY_VERSION=$S6_OVERLAY_VERSION" - >/dev/null
fi
tar_ctx | $D build -f tests/Dockerfile.stack --build-arg "BASE=$base" -t "$CCDASH_TEST_IMAGE" - >/dev/null

compose up -d >/dev/null
healthy() { curl -sf "$url/healthz"; }
until_ok 60 "dashboard answers /healthz" healthy

compose exec -T -u web ccdash node -e "require('/opt/ccdash/dashboard/lib/authstore').setCredentials({dir:'/var/lib/ccdash-web',username:'t',password:'test-password-123'})"
login() { curl -sf -c "$jar" -H "Origin: http://localhost:7690" -H 'X-CCDash: 1' -H 'content-type: application/json' \
  -d '{"username":"t","password":"test-password-123"}' "$url/login"; }
until_ok 20 "login" login
# api METHOD PATH [JSON]: prints "<status> <body>" (no -f: refusals are part of the test)
api() { local m=$1 p=$2 out; shift 2; local a=(); [ $# -gt 0 ] && a=(-H 'content-type: application/json' -d "$1")
  out=$(curl -s -b "$jar" -X "$m" -H "Origin: http://localhost:7690" -H 'X-CCDash: 1' ${a[@]+"${a[@]}"} -w '\n%{http_code}' "$url$p")
  printf '%s %s\n' "${out##*$'\n'}" "${out%$'\n'*}"; }
status() { api "$@" | cut -d' ' -f1; }
body() { api "$@" | cut -d' ' -f2-; }

# ---- a local "GitHub": bare repo + a second clone to push from --------------------------------------
BARE=/home/ccd/bare/demo.git
ccd bash -ec "
  mkdir -p /home/ccd/bare && git init -q --bare -b main $BARE
  git clone -q $BARE /home/ccd/seed 2>/dev/null
  cd /home/ccd/seed && git checkout -q -b main 2>/dev/null || true
  echo one > f && git add f && git -c user.name=seed -c user.email=s@example.com commit -qm one && git push -q origin main
  git config --global url.$BARE.insteadOf https://github.com/octo/demo.git"
push_commit() { ccd bash -ec "cd /home/ccd/seed && echo $1 > f && git -c user.name=seed -c user.email=s@example.com commit -qam $1 && git push -q origin main"; }
workhead() { ccd git -C /workspace/demo rev-parse HEAD; }
bare_head() { ccd git -C $BARE rev-parse main; }

# ---- add: clone + record + fake Claude starts -------------------------------------------------------
r=$(body POST /api/projects '{"repo":"octo/demo"}')
if [ "$(jq -r .session <<<"$r")" = claude-demo ]; then ok "add clones the project and starts a session"; else bad "add: $r"; fi
rec() { ccd jq -c . /home/ccd/.ccdash/projects/demo.json; }
if [ "$(rec | jq -r .repo)" = octo/demo ] && [ "$(rec | jq -r .head)" = "$(workhead)" ]; then ok "onboarding record written"; else bad "record: $(rec)"; fi
claude_up() { ccd pgrep -x -u ccd claude; }
until_ok 20 "fake claude is running" claude_up
pid=$(claude_up | head -n 1)
pane() { ccd tmux -S /run/ccdash/tmux.sock capture-pane -p -t '=claude-demo:' ; }
pane_before=$(pane)

# ---- pull fast-forwards while Claude keeps running ----------------------------------------------------
push_commit two
want=$(bare_head)
r=$(body POST /api/projects/demo/pull '{}')
if [ "$(jq -r .head <<<"$r")" = "${want:0:7}" ] && [ "$(jq -r .changed <<<"$r")" = true ]; then ok "pull advanced HEAD to ${want:0:7}"; else bad "pull: $r"; fi
if [ "$(workhead)" = "$want" ]; then ok "checkout is at the remote head"; else bad "checkout head $(workhead) != $want"; fi
if jq -e '.claude == true and (.message | contains("Claude was not restarted"))' <<<"$r" >/dev/null; then ok "message says Claude was not restarted"; else bad "message: $r"; fi
if [ "$(claude_up | head -n 1)" = "$pid" ]; then ok "same Claude process ($pid) still alive"; else bad "claude pid changed from $pid"; fi
if [ "$(pane)" = "$pane_before" ]; then ok "pane untouched"; else bad "pane changed"; fi
if [ "$(rec | jq -r .head)" = "$want" ]; then ok "record head updated"; else bad "record: $(rec)"; fi
if body GET /api/projects | jq -e --arg h "${want:0:7}" '.projects[] | select(.name == "demo") | .repo == "octo/demo" and .head == $h' >/dev/null; then ok "project list shows repo and head"; else bad "project list"; fi
r=$(body POST /api/projects/demo/pull '{}')
if jq -e '.changed == false and (.message | startswith("already up to date at "))' <<<"$r" >/dev/null; then ok "second pull: already up to date"; else bad "second pull: $r"; fi

# ---- dirty tree -----------------------------------------------------------------------------------------
ccd bash -c 'echo mine >> /workspace/demo/f'
push_commit three
before=$(workhead)
out=$(api POST /api/projects/demo/pull '{}')
if [ "${out%% *}" = 409 ] && grep -q 'uncommitted changes in demo; commit or stash first' <<<"$out"; then ok "dirty tree refused (409, clear message)"; else bad "dirty: $out"; fi
if [ "$(workhead)" = "$before" ]; then ok "dirty checkout unchanged"; else bad "dirty checkout moved"; fi
ccd git -C /workspace/demo checkout -q -- f

# ---- diverged branch ------------------------------------------------------------------------------------
ccd bash -ec 'cd /workspace/demo && echo local > g && git add g && git -c user.name=l -c user.email=l@example.com commit -qm local'
mine=$(workhead)
out=$(api POST /api/projects/demo/pull '{}')
if [ "${out%% *}" = 409 ] && grep -q 'demo has diverged from origin; resolve it in a shell' <<<"$out"; then ok "diverged branch refused (409, clear message)"; else bad "diverged: $out"; fi
if [ "$(workhead)" = "$mine" ]; then ok "diverged checkout unchanged"; else bad "diverged checkout moved"; fi
ccd git -C /workspace/demo reset -q --hard origin/main

# ---- unreachable remote ---------------------------------------------------------------------------------
before=$(workhead)
ccd bash -ec "git config --global --unset-all url.$BARE.insteadOf; git config --global url./nonexistent/demo.git.insteadOf https://github.com/octo/demo.git"
out=$(api POST /api/projects/demo/pull '{}')
if [ "${out%% *}" = 502 ] && grep -q 'pull failed' <<<"$out" && grep -q 'could not reach the remote' <<<"$out"; then ok "unreachable remote: 502 with the log"; else bad "unreachable: $out"; fi
if [ "$(workhead)" = "$before" ] && [ -z "$(ccd git -C /workspace/demo status --porcelain)" ]; then ok "HEAD and tree unchanged after the failed pull"; else bad "failed pull changed the checkout"; fi
ccd bash -ec "git config --global --unset-all url./nonexistent/demo.git.insteadOf; git config --global url.$BARE.insteadOf https://github.com/octo/demo.git"

# ---- another repo's folder, bad names, refused methods ---------------------------------------------------
check "unknown project -> 404" test "$(status POST /api/projects/nothere/pull '{}')" = 404
check "bad project name -> 400" test "$(status POST '/api/projects/a%3Bb/pull' '{}')" = 400
check "pull without the CSRF header -> 403" test "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -X POST -H 'Origin: http://localhost:7690' "$url/api/projects/demo/pull")" = 403
check "pull without a session -> 401" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: http://localhost:7690' -H 'X-CCDash: 1' "$url/api/projects/demo/pull")" = 401

# ---- git identity ----------------------------------------------------------------------------------------
check "identity unset at first" test "$(body GET /api/git-identity | jq -c '[.name, .email]')" = '[null,null]'
out=$(body POST /api/git-identity '{"name":"  Test User ","email":"test.user@example.com"}')
if [ "$(jq -r .message <<<"$out")" = 'git identity set to Test User test.user@example.com' ]; then ok "identity set through the API"; else bad "identity: $out"; fi
if [ "$(body GET /api/git-identity | jq -c '[.name, .email]')" = '["Test User","test.user@example.com"]' ]; then ok "identity read back"; else bad "identity readback: $(body GET /api/git-identity)"; fi
ccd bash -ec 'rm -rf /home/ccd/scratch && git init -q /home/ccd/scratch && cd /home/ccd/scratch && git commit -q --allow-empty -m x'
if [ "$(ccd git -C /home/ccd/scratch log -1 '--format=%an,%ae')" = 'Test User,test.user@example.com' ]; then ok "ccd's commit is authored by the identity"; else bad "commit author: $(ccd git -C /home/ccd/scratch log -1 '--format=%an,%ae')"; fi
# a trailing ';' in a name must survive tmux (it would end the command)
out=$(body POST /api/git-identity '{"name":"Pat O;","email":"pat@example.com"}')
if [ "$(body GET /api/git-identity | jq -c '[.name, .email]')" = '["Pat O;","pat@example.com"]' ]; then ok "name with a trailing ; round-trips"; else bad "semicolon name: $out"; fi
for hostile in '{"name":"a\nb","email":"a@b.co"}' '{"name":"","email":"a@b.co"}' '{"name":"ok","email":"a b@c.de"}' '{"name":"ok","email":"nope"}' '{"name":"ok","email":"a@b.co\nx"}' '{"name":5,"email":"a@b.co"}'; do
  check "hostile identity refused: $hostile" test "$(status POST /api/git-identity "$hostile")" = 400
done
if [ "$(body GET /api/git-identity | jq -r .name)" = 'Pat O;' ]; then ok "identity unchanged by refused requests"; else bad "identity changed: $(body GET /api/git-identity)"; fi
exit $fail
