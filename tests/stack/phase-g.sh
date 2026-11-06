#!/usr/bin/env bash
# Phase G on a test compose stack: the README "Backup and restore" procedure, end to end. Log in, enrol TOTP,
# add a project (a local bare repo stands in for GitHub), write marker files into the history and the
# workspace, stop the stack and tar each of the four volumes, `compose down -v` (volumes gone), bring up a
# fresh stack with empty volumes, stop it, untar into each volume, start, and check: same password and TOTP
# secret still log in, the markers and the project are back, and file owners are unchanged.
# The README uses a bind mount ("$PWD":/b); here the repo is unreadable by the Docker user and bind mounts are
# not available, so the archives go to a scratch named volume (ccdashtest-g-bk) mounted at /b instead.
# SCREENSHOT=1 also starts a few fake conversations in the restored stack and takes a desktop screenshot
# (1100x700, tests/playwright/specs/shot.test.js) into CCDASH_SHOT_OUT (default docs/screenshot.png).
# Needs docker (or CCDASH_DOCKER, e.g. "sudo -n -u ccdash /usr/local/bin/ccdash-docker"), curl, jq and tar. Own
# project and volumes (ccdashtest-g), all removed at the end. Env: CCDASH_TEST_PORT (7697), CCDASH_IMAGE
# (ccdash:ci, built from the checkout if missing), KEEP=1 (leave the stack up), DEBUG=1.
# shellcheck disable=SC2329,SC1091 # functions run through until_ok / trap; .env.example is a plain env file
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
D=${CCDASH_DOCKER:-docker} # may contain spaces; left unquoted on purpose
export CCDASH_TEST_PORT=${CCDASH_TEST_PORT:-7697}
base=${CCDASH_IMAGE:-ccdash:ci}
P=ccdashtest-g
BK=$P-bk
export CCDASH_TEST_IMAGE=ccdash-stack:$P
PW_IMAGE=ccdash-playwright:$P
PW_NAME=$P-playwright
url=http://127.0.0.1:$CCDASH_TEST_PORT
origin=http://localhost:7690
tmp=$(mktemp -d)
jar=$tmp/jar
fail=0
VOLS="home workspace web git"

compose() { (cd / && $D compose -p "$P" -f - "$@" < <(sed -e "s|@IMAGE@|$CCDASH_TEST_IMAGE|" -e "s|@PORT@|$CCDASH_TEST_PORT|" -e '/# phase-c$/d' "$root/tests/stack/compose.yaml")); }
ccd() { compose exec -T -u ccd ccdash "$@"; }
cleanup() {
  $D rm -f "$PW_NAME" >/dev/null 2>&1 || true
  if [ -z "${KEEP:-}" ]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    $D volume rm -f "$BK" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
indent() { sed "s/^/$1/"; } # indent PREFIX: put PREFIX in front of every line on stdin
until_ok() { # until_ok SECONDS DESCRIPTION CMD...
  local n=$1 what=$2; shift 2
  for _ in $(seq $((n * 5))); do if "$@" >/dev/null 2>&1; then ok "$what"; return 0; fi; sleep 0.2; done
  bad "$what (timed out after ${n}s)"
  if [ -n "${DEBUG:-}" ]; then compose logs --tail 20 || true; fi
  return 1
}
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
tar_ctx() { (cd "$root" && git ls-files -co --exclude-standard -- . ':!dashboard/node_modules' | grep -v '^docs/handoff\|^\.claude' | tar -c -T -); }
vol_exists() { $D volume inspect "$1" >/dev/null 2>&1; }

if ! $D image inspect "$base" >/dev/null 2>&1; then
  set -a; . "$root/.env.example"; set +a
  tar_ctx | $D build -q -t "$base" --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" --build-arg "S6_OVERLAY_VERSION=$S6_OVERLAY_VERSION" - >/dev/null
fi
tar_ctx | $D build -q -f tests/Dockerfile.stack --build-arg "BASE=$base" -t "$CCDASH_TEST_IMAGE" - >/dev/null

compose down -v --remove-orphans >/dev/null 2>&1 || true
$D volume rm -f "$BK" >/dev/null 2>&1 || true
$D volume create "$BK" >/dev/null

healthy() { curl -sf "$url/healthz"; }
login() { curl -sf -c "$jar" -H "Origin: $origin" -H 'X-CCDash: 1' -H 'content-type: application/json' \
  -d "{\"username\":\"t\",\"password\":\"test-password-123\"${1:+,\"code\":\"$1\"}}" "$url/login"; }
code_now() { compose exec -T -u web ccdash node -e "const t=require('/opt/ccdash/dashboard/lib/totp');process.stdout.write(t.hotp(process.argv[1],t.stepAt(Date.now())))" "$secret"; }
api() { local m=$1 p=$2 out; shift 2; local a=(); [ $# -gt 0 ] && a=(-H 'content-type: application/json' -d "$1")
  out=$(curl -s -b "$jar" -X "$m" -H "Origin: $origin" -H 'X-CCDash: 1' ${a[@]+"${a[@]}"} -w '\n%{http_code}' "$url$p")
  printf '%s %s\n' "${out##*$'\n'}" "${out%$'\n'*}"; }
pw_status() { curl -s -o /dev/null -w '%{http_code}' -H "Origin: $origin" -H 'X-CCDash: 1' -H 'content-type: application/json' -d '{"username":"t","password":"test-password-123"}' "$url/login"; }
body() { api "$@" | cut -d' ' -f2-; }
owners() { # numeric owner, group and mode of the markers and the project, from inside the container
  compose exec -T -u root ccdash sh -c 'stat -c "%u:%g %a %n" /home/ccd/.claude/history.jsonl /workspace/demo/MARKER /workspace/demo /var/lib/ccdash-web/auth.json /home/ccd/.ccdash/projects/demo.json'; }

echo "== first stack: log in, TOTP, project, markers"
compose up -d >/dev/null 2>&1
until_ok 60 "dashboard answers /healthz" healthy
compose exec -T -u web ccdash node -e "require('/opt/ccdash/dashboard/lib/authstore').setCredentials({dir:'/var/lib/ccdash-web',username:'t',password:'test-password-123'})"
until_ok 20 "login" login
BARE=/home/ccd/bare/demo.git
ccd bash -ec "
  mkdir -p /home/ccd/bare && git init -q --bare -b main $BARE
  git clone -q $BARE /home/ccd/seed 2>/dev/null
  cd /home/ccd/seed && git checkout -q -b main 2>/dev/null || true
  echo one > f && git add f && git -c user.name=seed -c user.email=s@example.com commit -qm one && git push -q origin main
  git config --global url.$BARE.insteadOf https://github.com/octo/demo.git"
r=$(body POST /api/projects '{"repo":"octo/demo"}')
eq "project demo added through the API" "$(jq -r .session <<<"$r")" claude-demo
ccd sh -c 'mkdir -p /home/ccd/.claude && echo "{\"display\":\"backup marker\"}" > /home/ccd/.claude/history.jsonl && echo marker-$$ > /workspace/demo/MARKER'
marker=$(ccd cat /workspace/demo/MARKER)
secret=$(compose exec -T -u web ccdash node -e "const t=require('/opt/ccdash/dashboard/lib/totp'),s=t.generateSecret();require('/opt/ccdash/dashboard/lib/authstore').enableTotp({dir:'/var/lib/ccdash-web',secret:s}).then(()=>process.stdout.write(s))")
eq "TOTP enabled (password alone is no longer enough)" "$(pw_status)" 401
before=$(owners); indent '     before: ' <<<"$before"
eq "markers are owned by ccd, not root" "$(echo "$before" | grep -c '^0:0 .*MARKER')" 0

echo "== backup: stop, tar each volume into $BK"
compose stop >/dev/null 2>&1
for v in $VOLS; do
  $D run --rm -v "$P"_"$v":/v -v "$BK":/b debian:trixie-slim tar czf "/b/$P-$v.tgz" -C /v --numeric-owner .
done
sizes=$($D run --rm -v "$BK":/b debian:trixie-slim ls -l /b | awk 'NR>1 {print $5, $9}')
indent '     archive: ' <<<"$sizes"
eq "four non-empty archives" "$(echo "$sizes" | awk '$1 > 100' | wc -l | tr -d ' ')" 4

echo "== delete: compose down -v"
compose down -v --remove-orphans >/dev/null 2>&1
gone=1; for v in $VOLS; do if vol_exists "${P}_$v"; then gone=0; fi; done
eq "all four stack volumes are gone" "$gone" 1

echo "== restore into new empty volumes"
compose up -d >/dev/null 2>&1
until_ok 60 "fresh stack answers /healthz" healthy
rm -f "$jar"
fresh=$(pw_status)
if [ "$fresh" != 200 ]; then ok "fresh stack does not know the login (HTTP $fresh)"; else bad "fresh stack accepted the login"; fi
compose stop >/dev/null 2>&1
for v in $VOLS; do
  $D run --rm -v "$P"_"$v":/v -v "$BK":/b debian:trixie-slim tar xzf "/b/$P-$v.tgz" --numeric-owner -C /v
done
compose start >/dev/null 2>&1
until_ok 60 "restored stack answers /healthz" healthy
eq "password alone still needs the TOTP code" "$(pw_status)" 401
login_code() { login "$(code_now)"; }
until_ok 20 "login with the same password and the same TOTP secret" login_code
eq "history marker is back" "$(ccd cat /home/ccd/.claude/history.jsonl)" '{"display":"backup marker"}'
eq "project marker file is back" "$(ccd cat /workspace/demo/MARKER)" "$marker"
if body GET /api/projects | jq -e '.projects[] | select(.name == "demo") | .repo == "octo/demo"' >/dev/null; then ok "project demo is in /api/projects"; else bad "project list: $(body GET /api/projects)"; fi
eq "project is still a git checkout of the seed commit" "$(ccd git -C /workspace/demo log -1 --format=%s)" one
after=$(owners); indent '     after:  ' <<<"$after"
eq "owners and modes are unchanged" "$after" "$before"

if [ -n "${SCREENSHOT:-}" ]; then
  echo "== screenshot (1100x700)"
  compose exec -T -u web ccdash node -e "require('/opt/ccdash/dashboard/lib/authstore').disableTotp({dir:'/var/lib/ccdash-web'})" # the browser spec logs in with the password only
  until_ok 20 "login (TOTP switched off for the screenshot)" login
  cid=$(compose ps -q ccdash)
  tar -C "$root/tests/playwright" -c --exclude=node_modules . | $D build -q -t "$PW_IMAGE" - >/dev/null
  for n in alpha beta gamma; do ccd mkdir -p "/workspace/$n"; ccd ccd-session start "$n" >/dev/null; done
  waiting() { body GET "/api/tree?all=1" | jq -e --arg p "$1" '[.projects[] | select(.project == $p) | .conversations[] | select(.status == "waiting")] | length >= 1'; }
  sid() { body GET "/api/tree?all=1" | jq -r --arg p "$1" '[.projects[] | select(.project == $p) | .conversations[] | select(.status != "ended")][0].sid'; }
  for n in alpha beta gamma; do until_ok 30 "$n is waiting" waiting "$n"; done
  api POST "/api/conversations/$(sid alpha)/prompt" '{"text":"Summarize the repo layout"}' >/dev/null
  api POST "/api/conversations/$(sid beta)/prompt" '{"text":"Add a backup section to the README"}' >/dev/null
  for n in alpha beta gamma; do until_ok 30 "$n is waiting again" waiting "$n"; done
  $D rm -f "$PW_NAME" >/dev/null 2>&1 || true
  $D run --name "$PW_NAME" --network "container:$cid" --ipc=host -e CCDASH_URL=$origin -e CCDASH_USER=t -e CCDASH_PASS=test-password-123 \
    -e OUT_DIR=/out "$PW_IMAGE" npm run test:shot || bad "screenshot spec failed"
  out=${CCDASH_SHOT_OUT:-$root/docs/screenshot.png}
  mkdir -p "$(dirname "$out")"
  if $D cp "$PW_NAME:/out/screenshot.png" - 2>/dev/null | tar -xO >"$out" 2>/dev/null && [ -s "$out" ]; then ok "screenshot saved to $out ($(wc -c < "$out") bytes)"; else bad "no screenshot produced"; fi
fi
exit $fail
