#!/usr/bin/env bash
# Phase C on a test compose stack: container-level checks the host tests cannot do (permissions of the
# broker socket, the hook's environment, falling through when the dashboard dies or the wait runs out),
# the controls through the API (hostile prompt byte for byte, interrupt, close, refusals), and a headless
# Chromium at a phone viewport (tests/playwright) for Approve/Deny, the prompt box and web push against
# a fake push service. Needs docker (or CCDASH_DOCKER, e.g. "sudo -n -u ccdash /usr/local/bin/ccdash-docker"),
# curl, jq, openssl and tar. Uses its own project and volumes (ccdashtest-c), removed at the end.
# Env: CCDASH_TEST_PORT (7692), CCDASH_IMAGE (ccdash:ci, built from the checkout if missing; remove it to
# pick up changes), CCDASH_SHOTS (a directory to copy the phone screenshots into), KEEP=1 (leave the
# stack up), DEBUG=1.
#
# How it fits together (the notes in NOTES.md "Phase C test stack" say more):
# - Two stacks, one after the other. (i) CCDASH_APPROVAL_WAIT=60, CCDASH_CLOSE_WAIT=3, CCDASH_RECONCILE_MS=500
#   for everything, including killing the dashboard mid-wait. (ii) CCDASH_APPROVAL_WAIT=5 for the timeout.
# - The compose file goes in on stdin with @WAIT@ and @CA@ filled in, so a Docker user that cannot read the
#   checkout still works. The push service's self-signed cert is made here with openssl, and its public
#   half is handed to the dashboard as a compose config file (bind-mounted at /etc/ccdash-test/push-ca.pem,
#   which NODE_EXTRA_CA_CERTS names; it lives in a world-readable temp subdirectory because the Docker user
#   may be someone else). The key and cert go to the browser container as environment variables.
# - The browser container joins the dashboard container's network namespace (--network container:ID), so
#   http://localhost:7690 is the dashboard (the default allowed Origin) and the fake push service the test
#   starts is reachable from the dashboard at https://localhost:8443.
# shellcheck disable=SC2329,SC1091 # functions run through until_ok / trap; .env.example is a plain env file
set -euo pipefail
# shellcheck source=tests/stack/lib-login.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib-login.sh"
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
D=${CCDASH_DOCKER:-docker} # may contain spaces; left unquoted on purpose
export CCDASH_TEST_PORT=${CCDASH_TEST_PORT:-7692}
base=${CCDASH_IMAGE:-ccdash:ci}
P=ccdashtest-c
export CCDASH_TEST_IMAGE=ccdash-stack:$P
PW_IMAGE=ccdash-playwright:$P
PW_NAME=$P-playwright
PUSH_PORT=8443
url=http://127.0.0.1:$CCDASH_TEST_PORT
origin=http://localhost:7690
tmp=$(mktemp -d)
jar=$tmp/jar
wait_sec=60
fail=0

compose() {
  (cd / && $D compose -p "$P" -f - "$@" < <(sed -e "s|@IMAGE@|$CCDASH_TEST_IMAGE|" -e "s|@PORT@|$CCDASH_TEST_PORT|" \
    -e "s|@WAIT@|$wait_sec|" -e "s|@CA@|$tmp/ca/push-ca.pem|" "$root/tests/stack/compose.yaml"))
}
ccd() { compose exec -T -u ccd ccdash "$@"; }
tm() { ccd tmux -S /run/ccdash/tmux.sock "$@"; }
cleanup() {
  if [ -z "${KEEP:-}" ]; then
    $D rm -f "$PW_NAME" >/dev/null 2>&1 || true
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
until_ok() { # until_ok SECONDS DESCRIPTION CMD...
  local n=$1 what=$2; shift 2
  for _ in $(seq $((n * 5))); do if "$@" >/dev/null 2>&1; then ok "$what"; return 0; fi; sleep 0.2; done
  bad "$what (timed out after ${n}s)"
  if [ -n "${DEBUG:-}" ]; then states | jq -c . || true; tm list-panes -a -F '#{session_name} #{pane_id} #{pane_pid}' || true; compose logs --tail 20 || true; fi
  return 1
}
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
tar_ctx() { (cd "$root" && git ls-files -co --exclude-standard -- . ':!dashboard/node_modules' | grep -v '^docs/handoff\|^\.claude' | tar -c -T -); }

# ---------------------------------------------------------------- images and certificate
if ! $D image inspect "$base" >/dev/null 2>&1; then
  set -a; . "$root/.env.example"; set +a
  tar_ctx | $D build -q -t "$base" --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" --build-arg "S6_OVERLAY_VERSION=$S6_OVERLAY_VERSION" --build-arg "BASIC_MEMORY_VERSION=$BASIC_MEMORY_VERSION" --build-arg "KIT_REPO=$KIT_REPO" --build-arg "KIT_REF=$KIT_REF" - >/dev/null
fi
tar_ctx | $D build -q -f tests/Dockerfile.stack --build-arg "BASE=$base" -t "$CCDASH_TEST_IMAGE" - >/dev/null
tar -C "$root/tests/playwright" -c --exclude=node_modules . | $D build -q -t "$PW_IMAGE" - >/dev/null

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
  -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 2>/dev/null
mkdir -m 0755 "$tmp/ca" # only the public cert goes here: a rootless Docker user has to read it
install -m 0644 "$tmp/cert.pem" "$tmp/ca/push-ca.pem"
chmod 0755 "$tmp"

# ---------------------------------------------------------------- helpers for a running stack
healthy() { curl -sf "$url/healthz"; }
login() { curl -sf -c "$jar" -H "Origin: $origin" -H 'X-CCDash: 1' -H 'content-type: application/json' \
  -d '{"username":"t","password":"test-password-123"}' "$url/login"; }
api() { curl -sf -b "$jar" -H "Origin: $origin" -H 'X-CCDash: 1' "$@"; }
# req METHOD PATH [JSON]: sets $status and $body (any status is fine).
req() {
  local out
  out=$(curl -s -b "$jar" -X "$1" -H "Origin: $origin" -H 'X-CCDash: 1' -H 'content-type: application/json' -d "${3:-{\}}" -w '\n%{http_code}' "$url$2")
  status=${out##*$'\n'}; body=${out%$'\n'*}
}
# states: the conversations as one JSON array ({sid, project, status, approval?}), taken from the first
# state message on /events (the windows API lists windows, not conversations).
cat >"$tmp/states.js" <<'JS'
const { WebSocket } = require(process.argv[2]);
const [,, , wsUrl, origin, cookie] = process.argv;
const ws = new WebSocket(wsUrl, { headers: { origin, cookie } });
const bail = setTimeout(() => process.exit(1), 5000);
ws.on('error', () => process.exit(1));
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type !== 'state') return;
  clearTimeout(bail);
  console.log(JSON.stringify(Object.entries(m.states).map(([sid, v]) => ({ sid, ...v }))));
  ws.terminate();
});
JS
states() {
  local ck
  ck=$(awk '$6 == "__Host-ccdash" { printf "%s=%s", $6, $7 }' "$jar")
  node "$tmp/states.js" "$root/dashboard/node_modules/ws" "ws${url#http}/events" "$origin" "$ck"
}
live() { states | jq -r --arg p "$1" '[.[] | select(.project == $p and .status != "ended" and .status != "sleeping")][0] | '"$2"; }
sid_of() { live "$1" '.sid // empty'; }
status_of() { live "$1" '.status // empty'; }
is_status() { [ "$(status_of "$1")" = "$2" ]; }
pane_of() { ccd jq -r .pane "/home/ccd/.ccdash/sessions/$1.json"; }
# shellcheck disable=SC2016 # the loop runs in the container's shell
claude_env() { ccd sh -c 'for p in $(pgrep -u ccd -x claude); do tr "\0" "\n" </proc/$p/environ; done' | sort -u; }
pane_text() { tm capture-pane -p -t "$(pane_of "$1")"; }

fresh_stack() { # fresh_stack WAIT_SECONDS: a new stack with empty volumes
  wait_sec=$1
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  compose up -d >/dev/null
  until_ok 60 "dashboard answers /healthz (approval wait ${wait_sec}s)" healthy
  compose exec -T -u web ccdash node -e "require('/opt/ccdash/dashboard/lib/authstore').setCredentials({dir:'/var/lib/ccdash-web',username:'t',password:'test-password-123'})"
  until_ok 20 "login" login
}
start_conv() { # start_conv PROJECT
  ccd mkdir -p "/workspace/$1"
  stack_login "$1"
  ccd ccd-session start "$1" >/dev/null
  until_ok 30 "$1 is waiting" is_status "$1" waiting
}
send() { req POST "/api/conversations/$(sid_of "$1")/prompt" "$(jq -nc --arg t "$2" '{text: $t}')"; }

# ================================================================ stack (i): approval wait 60 s
fresh_stack 60
cid=$(compose ps -q ccdash)

echo "== container level"
eq "/run/ccdash-web is web:ccd 750" "$(compose exec -T ccdash stat -c '%U:%G %a' /run/ccdash-web)" "web:ccd 750"
eq "broker socket is web:ccd 660" "$(compose exec -T ccdash stat -c '%U:%G %a' /run/ccdash-web/broker.sock)" "web:ccd 660"
eq "socket is a socket" "$(compose exec -T ccdash stat -c %F /run/ccdash-web/broker.sock)" "socket"
eq "managed settings: PermissionRequest hook timeout is 150" \
  "$(compose exec -T ccdash jq -c '[.hooks.PermissionRequest[].hooks[] | [.command, .timeout]]' /etc/claude-code/managed-settings.json)" \
  '[["/usr/local/lib/ccdash/hooks/permission.sh",150]]'
if ccd cat /var/lib/ccdash-web/push.json >/dev/null 2>&1; then bad "ccd can read the web store"; else ok "ccd cannot read the web store (push keys, password hash)"; fi
if ccd touch /run/ccdash-web/x 2>/dev/null; then bad "ccd can write into /run/ccdash-web"; else ok "ccd cannot create files in /run/ccdash-web"; fi

start_conv api1
start_conv api2
sock=/run/ccdash-web/broker.sock
forge() { # forge METHOD PATH JSON -> "<status> <body>" as ccd, over the socket
  ccd curl -s --unix-socket "$sock" -X "$1" -H 'content-type: application/json' -d "$3" -w ' %{http_code}' "http://broker$2"
}
if claude_env | grep -qx 'CCDASH_APPROVAL_WAIT=60'; then ok "CCDASH_APPROVAL_WAIT=60 reaches the claude process (the hook's environment)"; else bad "CCDASH_APPROVAL_WAIT does not reach the claude process"; fi
unk='{"session_id":"00000000-0000-0000-0000-000000000000","tool_name":"Bash","tool_input":{"command":"x"},"pane":"%0"}'
r=$(forge POST /permission "$unk"); eq "ccd POST for an unknown conversation is refused" "${r##* }" 404
if grep -qi allow <<<"$r"; then bad "forged request produced an allow: $r"; else ok "forged request returned no allow"; fi
r=$(forge POST /permission '{"session_id":"x"}'); eq "ccd POST with a malformed body is refused" "${r##* }" 400
r=$(forge GET /permission ''); eq "GET /permission is not allowed" "${r##* }" 405
r=$(forge POST /api/approvals/0123456789abcdef/decision '{"behavior":"allow"}'); eq "no approve route on the socket" "${r##* }" 404
r=$(forge POST /permission@evil '{}'); eq "other paths are not served" "${r##* }" 404

echo "== controls through the API"
a1=$(sid_of api1)
hostile=$'say "hi" $(touch /tmp/pwned); `touch /tmp/pwned2` \\ \x27q\x27 | & > /tmp/pwned3 ; Enter\nsecond line with Enter and \'; $HOME\n\ttabbed line'
send api1 "$hostile"
eq "hostile prompt accepted" "$status" 200
until_ok 15 "hostile prompt reached claude" ccd test -f "/home/ccd/.fake-claude/prompts/$a1.1"
printf '%s' "$hostile" >"$tmp/want"
ccd cat "/home/ccd/.fake-claude/prompts/$a1.1" >"$tmp/got"
if cmp -s "$tmp/want" "$tmp/got"; then ok "prompt arrived byte for byte ($(wc -c <"$tmp/got") bytes)"; else bad "prompt differs"; od -c "$tmp/got" | head -20; fi
if ccd sh -c 'ls /tmp/pwned* >/dev/null 2>&1'; then bad "a shell metacharacter was executed"; else ok "nothing in the prompt was executed"; fi
until_ok 20 "api1 is waiting again" is_status api1 waiting

big=$(head -c 8001 /dev/zero | tr '\0' a)
send api1 "$big"
eq "8001-byte prompt refused with 413" "$status" 413
if jq -e '.error | test("8001 bytes.*8000")' >/dev/null <<<"$body"; then ok "the refusal names the size and the limit"; else bad "refusal text: $body"; fi
send api1 "/long"
until_ok 15 "api1 is working on /long" is_status api1 working
send api1 "second"
eq "prompt refused while working" "$status" 409
req POST "/api/conversations/$a1/interrupt"
eq "Interrupt accepted" "$status" 200
until_ok 15 "Interrupt stopped the turn (waiting)" is_status api1 waiting
req POST "/api/conversations/$a1/close"
eq "Close of a waiting conversation" "$status" 200
eq "Close -> ended" "$(jq -r .result <<<"$body")" ended
api1_ended() { [ "$(states | jq -r '[.[] | select(.project == "api1") | .status] | first')" = ended ]; }
until_ok 15 "api1 is ended in the tree" api1_ended

# The largest allowed prompt, on a conversation of its own (the fake claude's tty handling of a huge paste
# can leave a stray escape behind that would end a later /long).
start_conv api3
a3=$(sid_of api3)
send api3 "$(head -c 8000 /dev/zero | tr '\0' a)"
eq "8000-byte prompt accepted" "$status" 200
until_ok 15 "the 8000-byte prompt reached claude" ccd test -f "/home/ccd/.fake-claude/prompts/$a3.1"
eq "all 8000 bytes arrived" "$(ccd stat -c %s "/home/ccd/.fake-claude/prompts/$a3.1")" 8000

a2=$(sid_of api2)
send api2 "/long"
until_ok 15 "api2 is working on /long" is_status api2 working
t0=$(date +%s)
req POST "/api/conversations/$a2/close"
t1=$(date +%s)
eq "Close of a stuck /long -> killed" "$(jq -r .result <<<"$body")" killed
if [ $((t1 - t0)) -ge 3 ] && [ $((t1 - t0)) -le 9 ]; then ok "killed after CCDASH_CLOSE_WAIT (took $((t1 - t0)) s)"; else bad "close took $((t1 - t0)) s, want about 3"; fi

echo "== phone browser (Playwright)"
for p in ph pa pb pc; do start_conv $p; done
shots=$tmp/shots
PW_RC=0
# The key and cert are passed as environment variables (docker run -e takes the value as an argument).
$D rm -f "$PW_NAME" >/dev/null 2>&1 || true
$D run --name "$PW_NAME" --network "container:$cid" --ipc=host \
  -e "PUSH_KEY=$(cat "$tmp/key.pem")" -e "PUSH_CERT=$(cat "$tmp/cert.pem")" -e PUSH_PORT=$PUSH_PORT \
  -e CCDASH_URL=$origin -e CCDASH_USER=t -e CCDASH_PASS=test-password-123 -e OUT_DIR=/out "$PW_IMAGE" || PW_RC=$?
mkdir -p "$shots"
$D cp "$PW_NAME:/out/." - 2>/dev/null | tar -x -C "$shots" 2>/dev/null || true # as a tar stream: the Docker user may not own $shots
$D rm -f "$PW_NAME" >/dev/null 2>&1 || true
if [ "$PW_RC" = 0 ]; then ok "Playwright specs passed"; else bad "Playwright specs failed (exit $PW_RC)"; fi
if [ -n "${CCDASH_SHOTS:-}" ]; then mkdir -p "$CCDASH_SHOTS" && cp "$shots"/*.png "$CCDASH_SHOTS"/ 2>/dev/null && echo "screenshots in $CCDASH_SHOTS" || true; fi
events=$(ccd cat /home/ccd/.fake-claude/events.log || true)
eq "events.log: two allows (pa, and pc in the push spec)" "$(grep -c '^permission allow$' <<<"$events")" 2
eq "events.log: the deny message arrived" "$(grep -c '^permission-message: nope-xyz$' <<<"$events")" 1
eq "events.log: exactly one deny" "$(grep -c '^permission deny$' <<<"$events")" 1

echo "== killing the dashboard mid-wait"
start_conv k1
send k1 "/perm"
until_ok 15 "k1 waits for a decision (needs_approval)" is_status k1 needs_approval
k1=$(sid_of k1)
pend() { states | jq -e --arg s "$k1" '[.[] | select(.sid == $s) | .approval.tool] | first == "Bash"'; }
until_ok 10 "the approval is pending in the tree" pend
pane=$(pane_of "$k1")
r=$(forge POST /permission "$(jq -nc --arg s "$k1" --arg p "$pane" '{session_id: $s, tool_name: "Bash", tool_input: {command: "forged"}, pane: $p}')")
eq "ccd cannot add a second request while one is pending" "${r##* }" 409
r=$(forge POST /permission "$(jq -nc --arg s "$k1" '{session_id: $s, tool_name: "Bash", tool_input: {}, pane: "%999"}')")
eq "ccd cannot post with another pane" "${r##* }" 403
if grep -q 'fall-through' <<<"$(pane_text "$k1")"; then bad "terminal dialog showed too early"; else ok "no terminal dialog while the dashboard waits"; fi
compose exec -T -u root ccdash pkill -9 -f 'node /opt/ccdash/dashboard/server.js'
shows_dialog() { grep -q 'fall-through: asking user' <<<"$(pane_text "$k1")"; }
until_ok 10 "killing the dashboard makes the terminal dialog appear" shows_dialog
until_ok 60 "s6 restarted the dashboard" healthy
login >/dev/null

# ================================================================ stack (ii): approval wait 5 s
echo "== approval wait of 5 s"
fresh_stack 5
start_conv w1
send w1 "/perm"
until_ok 15 "w1 waits for a decision (needs_approval)" is_status w1 needs_approval
w1=$(sid_of w1)
if grep -q 'fall-through' <<<"$(pane_text "$w1")"; then bad "dialog showed before the wait ran out"; else ok "no dialog yet at the start of the wait"; fi
w1dialog() { grep -q 'fall-through: asking user' <<<"$(pane_text "$w1")"; }
until_ok 15 "an unanswered request shows the terminal dialog after 5 s" w1dialog
eq "claude's environment has CCDASH_APPROVAL_WAIT=5" "$(claude_env | grep -c '^CCDASH_APPROVAL_WAIT=5$')" 1
exit $fail
