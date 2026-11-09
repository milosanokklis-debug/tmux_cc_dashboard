#!/usr/bin/env bash
# Phase E on a test compose stack, inside the real image (so the ccd-reader s6 service runs): the reader
# socket and what it refuses, the usage gauges (/api/usage against the fake claude's rate_limits, then
# "unknown" when the statusline has none), a subagent in /api/tree within 2 s with a readable transcript,
# token totals against a sum computed here with jq, CPU and memory of the dashboard's node process with
# 10 conversations (idle with one /events client, and with the fake claudes active), and a headless
# Chromium (tests/playwright/specs/phase-e.test.js) at 390x844 and 1280x800 that opens the Usage panel,
# the tree and a subagent transcript, takes screenshots and checks that an idle cards view makes no HTTP
# requests. Needs docker (or CCDASH_DOCKER, e.g. "sudo -n -u ccdash /usr/local/bin/ccdash-docker"), curl,
# jq and tar. Own project and volumes (ccdashtest-e, or per part below), removed at the end.
# PHASE_E_PART=core|load runs half (CI runs them as two legs, "stack (phase-e core)" and "stack (phase-e load)"); unset or empty runs both. core: reader socket,
# usage gauges, subagent, refusals, token totals (project ccdashtest-e-core, port 7694); load: 10 conversations,
# CPU/memory, browser (project ccdashtest-e-load, port 7695); both: project ccdashtest-e, port 7694.
# Env: CCDASH_TEST_PORT (7694, or 7695 for load), CCDASH_IMAGE (ccdash:ci, built from the checkout if missing; remove it to
# pick up changes), CCDASH_SHOTS (directory for the screenshots, default tests/stack/out, gitignored),
# SAMPLE_SEC (CPU sampling window, default 35, at least 30 to count), ACTIVE_MAX_CPU (limit while the fake claudes are active, default 3), KEEP=1 (leave the stack up), DEBUG=1.
# shellcheck disable=SC2329,SC1091 # functions run through until_ok / trap; .env.example is a plain env file
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
D=${CCDASH_DOCKER:-docker} # may contain spaces; left unquoted on purpose
part=${PHASE_E_PART:-}
case $part in
  core) P=ccdashtest-e-core; defport=7694 ;;
  load) P=ccdashtest-e-load; defport=7695 ;;
  "") P=ccdashtest-e; defport=7694 ;;
  *) echo "PHASE_E_PART must be core or load (or unset for both), got '$part'" >&2; exit 2 ;;
esac
export CCDASH_TEST_PORT=${CCDASH_TEST_PORT:-$defport}
base=${CCDASH_IMAGE:-ccdash:ci}
export CCDASH_TEST_IMAGE=ccdash-stack:$P
PW_IMAGE=ccdash-playwright:$P
PW_NAME=$P-playwright
SAMPLE_SEC=${SAMPLE_SEC:-35}
ACTIVE_MAX_CPU=${ACTIVE_MAX_CPU:-3}
SHOTS=${CCDASH_SHOTS:-$root/tests/stack/out}
url=http://127.0.0.1:$CCDASH_TEST_PORT
origin=http://localhost:7690
tmp=$(mktemp -d)
jar=$tmp/jar
fail=0
bg=""

compose() { (cd / && $D compose -p "$P" -f - "$@" < <(sed -e "s|@IMAGE@|$CCDASH_TEST_IMAGE|" -e "s|@PORT@|$CCDASH_TEST_PORT|" -e '/# phase-c$/d' "$root/tests/stack/compose.yaml")); }
ccd() { compose exec -T -u ccd ccdash "$@"; }
tm() { ccd tmux -S /run/ccdash/tmux.sock "$@"; }
cleanup() {
  [ -n "$bg" ] && kill "$bg" 2>/dev/null || true
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
  if [ -n "${DEBUG:-}" ]; then compose logs --tail 30 || true; fi
  return 1
}
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
tar_ctx() { (cd "$root" && git ls-files -co --exclude-standard -- . ':!dashboard/node_modules' | grep -v '^docs/handoff\|^\.claude' | tar -c -T -); }

# ---------------------------------------------------------------- images
if ! $D image inspect "$base" >/dev/null 2>&1; then
  set -a; . "$root/.env.example"; set +a
  tar_ctx | $D build -q -t "$base" --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" --build-arg "S6_OVERLAY_VERSION=$S6_OVERLAY_VERSION" --build-arg "BASIC_MEMORY_VERSION=$BASIC_MEMORY_VERSION" --build-arg "KIT_REPO=$KIT_REPO" --build-arg "KIT_REF=$KIT_REF" - >/dev/null
fi
tar_ctx | $D build -q -f tests/Dockerfile.stack --build-arg "BASE=$base" -t "$CCDASH_TEST_IMAGE" - >/dev/null
tar -C "$root/tests/playwright" -c --exclude=node_modules . | $D build -q -t "$PW_IMAGE" - >/dev/null

compose down -v --remove-orphans >/dev/null 2>&1 || true
compose up -d >/dev/null
cid=$(compose ps -q ccdash)
healthy() { curl -sf "$url/healthz"; }
until_ok 60 "dashboard answers /healthz" healthy
compose exec -T -u web ccdash node -e "require('/opt/ccdash/dashboard/lib/authstore').setCredentials({dir:'/var/lib/ccdash-web',username:'t',password:'test-password-123'})"
login() { curl -sf -c "$jar" -H "Origin: $origin" -H 'X-CCDash: 1' -H 'content-type: application/json' \
  -d '{"username":"t","password":"test-password-123"}' "$url/login"; }
until_ok 20 "login" login
api() { curl -sf -b "$jar" -H "Origin: $origin" -H 'X-CCDash: 1' "$@"; }
req() { curl -s -o /dev/null -b "$jar" -X "$1" -H "Origin: $origin" -H 'X-CCDash: 1' -H 'content-type: application/json' -d "${3:-{\}}" "$url$2"; } # req METHOD PATH [JSON]
tree() { api "$url/api/tree?all=1"; }
live() { tree | jq -r --arg p "$1" '[.projects[] | select(.project == $p) | .conversations[] | select(.status != "ended" and .status != "sleeping")][0] | '"$2"; }
sid_of() { live "$1" '.sid // empty'; }
is_idle() { [ "$(live "$1" '.idle // empty')" = true ]; }
is_status() { [ "$(live "$1" '.status // empty')" = "$2" ]; }
start_conv() { # start_conv PROJECT
  ccd mkdir -p "/workspace/$1"
  ccd ccd-session start "$1" >/dev/null
  until_ok 30 "$1 is waiting" is_status "$1" waiting
}
send() { req POST "/api/conversations/$(sid_of "$1")/prompt" "$(jq -nc --arg t "$2" '{text: $t}')"; }
# The fake claude reads these when it starts, so they go into tmux's global environment first.
fake_env() { tm set-environment -g "$1" "$2"; }
fake_unset() { tm set-environment -gu "$1" || true; }
# Transcripts are 0600 in 0700 directories, as Claude Code writes them (the fake uses the umask).
lock_transcripts() { ccd sh -c 'find /home/ccd/.claude/projects -type d -exec chmod 700 {} + ; find /home/ccd/.claude/projects -type f -exec chmod 600 {} +'; }
tfile() { ccd find /home/ccd/.claude/projects -name "$1.jsonl" -not -path '*/subagents/*'; }

ccd mkdir -p /home/ccd/.claude/projects
ccd chmod 700 /home/ccd/.claude /home/ccd/.claude/projects
fake_env FAKE_CLAUDE_TRANSCRIPTS /home/ccd/.claude/projects

if [ "$part" != load ]; then
echo "== ccd-reader service in the image"
eq "reader.sock is ccd:ccd 660" "$(compose exec -T ccdash stat -c '%U:%G %a' /run/ccdash/reader.sock)" "ccd:ccd 660"
eq "reader.sock is a socket" "$(compose exec -T ccdash stat -c %F /run/ccdash/reader.sock)" "socket"
eq "the reader process runs as ccd" "$(compose exec -T ccdash ps -o user= -C node -o args= | grep -c '^ccd .*reader.js')" 1

echo "== usage gauges"
fake_env FAKE_CLAUDE_RATE_LIMITS "62 17"
start_conv gauge
send gauge "/status"
usage_ok() { api "$url/api/usage" | jq -e '(.five_hour.status == "ok") and (.seven_day.status == "ok")'; }
until_ok 15 "/api/usage has both windows after /status" usage_ok
u=$(api "$url/api/usage")
if jq -e '(.five_hour.used_percentage - 62 | fabs) <= 1 and (.seven_day.used_percentage - 17 | fabs) <= 1' <<<"$u" >/dev/null; then
  ok "gauges match the statusline: five_hour $(jq .five_hour.used_percentage <<<"$u"), seven_day $(jq .seven_day.used_percentage <<<"$u") (want 62 and 17)"
else bad "gauges: $u"; fi
eq "usage source is the statusline" "$(jq -r .source <<<"$u")" statusline
# End that conversation and forget its reading; the next statusline has no rate_limits at all.
req POST "/api/conversations/$(sid_of gauge)/close"
ccd sh -c 'rm -f /home/ccd/.ccdash/usage/*.json'
fake_env FAKE_CLAUDE_RATE_LIMITS none
start_conv nolimits
send nolimits "/status"
unknown_both() { api "$url/api/usage" | jq -e '.five_hour.status == "unknown" and .seven_day.status == "unknown"'; }
reading_written() { [ "$(ccd sh -c 'ls /home/ccd/.ccdash/usage/*.json 2>/dev/null | wc -l')" -ge 1 ]; }
until_ok 15 "a statusline reading without rate_limits was recorded" reading_written
until_ok 10 "both windows are unknown (nothing estimated)" unknown_both
fake_unset FAKE_CLAUDE_RATE_LIMITS
req POST "/api/conversations/$(sid_of nolimits)/close"
# The dashboard runs as web and cannot delete in the 0750 ccd usage dir: it must still read it fine,
# and the 7-day prune is the statusline script's job (ccd side, once a day).
web() { compose exec -T -u web ccdash "$@"; }
eq "web user can read the usage dir" "$(web sh -c 'ls /home/ccd/.ccdash/usage/*.json >/dev/null 2>&1 && echo yes')" yes
if web sh -c 'rm -f /home/ccd/.ccdash/usage/*.json' 2>/dev/null; then bad "web user could delete usage readings"; else ok "web user cannot delete usage readings"; fi
ccd sh -c 'echo "{\"ts\":1}" > /home/ccd/.ccdash/usage/old-prune.json; touch -d "10 days ago" /home/ccd/.ccdash/usage/old-prune.json; rm -f /home/ccd/.ccdash/.pruned'
ccd sh -c 'echo "{}" | /usr/local/lib/ccdash/hooks/statusline.sh' >/dev/null
old_gone() { ! ccd test -e /home/ccd/.ccdash/usage/old-prune.json; }
until_ok 5 "statusline.sh pruned the 10-day-old reading ccd-side" old_gone
if api "$url/api/usage" | jq -e '.five_hour.status' >/dev/null; then ok "/api/usage still answers"; else bad "/api/usage failed"; fi

echo "== subagent"
start_conv subp
subp=$(sid_of subp)
t0=$(date +%s.%N)
send subp "/sub"
has_sub() { api "$url/api/tree" | jq -e --arg s "$subp" '[.projects[].conversations[] | select(.sid == $s) | .subagents[]] | length >= 1'; }
found=0
for _ in $(seq 20); do if has_sub >/dev/null 2>&1; then found=1; break; fi; sleep 0.1; done
dt=$(awk -v a="$t0" -v b="$(date +%s.%N)" 'BEGIN { printf "%.2f", b - a }')
if [ "$found" = 1 ]; then ok "subagent in /api/tree ${dt}s after the prompt (limit 2 s)"; else bad "subagent not in /api/tree after ${dt}s"; fi
lock_transcripts
aid=$(api "$url/api/tree" | jq -r --arg s "$subp" '[.projects[].conversations[] | select(.sid == $s) | .subagents[]][0].agent_id')
tr_status() { curl -s -o "$tmp/tr" -w '%{http_code}' -b "$jar" -H "Origin: $origin" -H 'X-CCDash: 1' "$url/api/transcript?conv=$subp&agent=$1"; }
eq "subagent transcript answers 200" "$(tr_status "$aid")" 200
if jq -e '.entries | length >= 2' "$tmp/tr" >/dev/null; then ok "subagent transcript has entries ($(jq '.entries | length' "$tmp/tr"))"; else bad "subagent transcript: $(head -c 300 "$tmp/tr")"; fi
if jq -e '[.entries[].parts[].text] | any(contains("subagent reply"))' "$tmp/tr" >/dev/null; then ok "subagent reply text is in the transcript"; else bad "reply text missing"; fi
eq "main transcript answers 200" "$(tr_status main)" 200
eq "an unknown agent id answers 404" "$(tr_status ffffffffffffffff)" 404

echo "== reader refusals and permissions"
tf=$(tfile "$subp")
eq "the transcript is 0600 ccd:ccd on disk" "$(ccd stat -c '%U:%G %a' "$tf")" "ccd:ccd 600"
if compose exec -T -u web ccdash cat "$tf" >/dev/null 2>&1; then bad "web can read the transcript directly"; else ok "web cannot read the transcript directly"; fi
rd='const s=require("net").connect("/run/ccdash/reader.sock");s.write(JSON.stringify({op:"stat",path:process.argv[1]})+"\n");s.on("data",d=>{process.stdout.write(d);s.end()});s.on("error",()=>process.exit(2))'
rdweb() { compose exec -T -u web ccdash node -e "$rd" "$1"; }
if rdweb "$tf" | jq -e '.ok == true' >/dev/null; then ok "web reads the transcript through the reader"; else bad "reader stat of the transcript: $(rdweb "$tf")"; fi
ccd sh -c 'echo secret > /home/ccd/outside.txt; mkdir -p /home/ccd/.claude/projects-evil && echo x > /home/ccd/.claude/projects-evil/f.jsonl; ln -sfn /home/ccd/outside.txt /home/ccd/.claude/projects/link.jsonl; ln -sfn /etc /home/ccd/.claude/projects/etc-link'
for p in /etc/passwd /home/ccd/outside.txt /home/ccd/.claude/projects-evil/f.jsonl /home/ccd/.claude/projects/link.jsonl /home/ccd/.claude/projects/etc-link/passwd "/home/ccd/.claude/projects/../outside.txt" relative/path; do
  r=$(rdweb "$p" || true)
  if jq -e '.ok == false' <<<"$r" >/dev/null 2>&1 && ! grep -q secret <<<"$r"; then ok "reader refuses $p ($(jq -r .error <<<"$r"))"; else bad "reader answered for $p: $r"; fi
done
ccd rm -rf /home/ccd/.claude/projects/link.jsonl /home/ccd/.claude/projects/etc-link /home/ccd/.claude/projects-evil /home/ccd/outside.txt

echo "== token totals"
fake_env FAKE_CLAUDE_USAGE "7 11 13 17"
start_conv tok
tok=$(sid_of tok)
for i in 1 2 3; do
  until_ok 20 "tok is waiting before prompt $i" is_status tok waiting
  send tok "question $i"
done
until_ok 20 "tok is waiting" is_status tok waiting
f=$(tfile "$tok")
# Extra assistant messages with varied usage, each written twice (one line per content block), and a
# model with no price, appended the way Claude Code would.
ccd sh -c "cd \$(dirname $f) && for n in 1 2 3; do
  for _ in 1 2; do jq -nc --argjson n \$n '{type:\"assistant\",timestamp:\"2026-01-01T00:00:0\\(\$n).000Z\",requestId:(\"req_x\\(\$n)\"),message:{id:(\"msg_x\\(\$n)\"),model:(if \$n == 3 then \"mystery-model\" else \"claude-opus-5\" end),role:\"assistant\",content:[{type:\"text\",text:\"x\"}],usage:{input_tokens:(100*\$n),output_tokens:(5*\$n),cache_creation_input_tokens:(1000*\$n),cache_read_input_tokens:(10000*\$n)}}}' >> $f; done; done"
want=$(ccd cat "$f" | jq -sc '[.[] | select(.type == "assistant")] | group_by(.message.id) | map(last.message.usage)
  | {input: (map(.input_tokens) | add), output: (map(.output_tokens) | add), cache_creation: (map(.cache_creation_input_tokens) | add), cache_read: (map(.cache_read_input_tokens) | add), messages: length}')
# a hand sum as a sanity check of the jq: one message (7 11 13 17) per prompt the fake saw, plus x1..x3
nprompts=$(ccd sh -c "ls /home/ccd/.fake-claude/prompts/$tok.* | wc -l")
eq "independent sum: $nprompts prompts + 3 extra messages, hand-computed input" "$(jq -c '[.messages, .input]' <<<"$want")" "[$((nprompts + 3)),$((nprompts * 7 + 600))]"
tok_match() { api "$url/api/tokens?conversation=$tok" | jq -e --argjson w "$want" '.total | {input, output, cache_creation, cache_read, messages} == $w'; }
until_ok 20 "/api/tokens?conversation= equals the manual sum $(jq -c . <<<"$want")" tok_match
if api "$url/api/tokens?conversation=$tok" | jq -e '.unpriced_models | index("mystery-model")' >/dev/null; then ok "the model with no price is listed as unpriced"; else bad "unpriced_models"; fi
lock_transcripts
fi # core

if [ "$part" != core ]; then
echo "== load: 10 conversations"
fake_unset FAKE_CLAUDE_USAGE
fake_env FAKE_CLAUDE_RATE_LIMITS none # the gauges stay "unknown" for the browser
for i in 3 4 5 6 7 8; do start_conv "l$i"; done
if [ -z "$part" ]; then req POST "/api/conversations/$tok/close"; req POST "/api/conversations/$subp/close"; fi # both mode: close core's conversations so ten are live
start_conv l1; start_conv l2; start_conv l9; start_conv l10
for i in 1 2 3 4 5 6 7 8 9 10; do until_ok 20 "l$i is waiting" is_status "l$i" waiting; send "l$i" "hello $i"; done
# one with a subagent for the browser to open
for i in 1 2 3 4 5 6 7 8 9 10; do until_ok 20 "l$i is waiting again" is_status "l$i" waiting; done
send l1 "/sub"
until_ok 15 "l1 is waiting after /sub" is_status l1 waiting
lock_transcripts
live_n=$(tree | jq '[.projects[].conversations[] | select(.status != "ended" and .status != "sleeping")] | length')
eq "ten live conversations" "$live_n" 10

# One /events client for the whole measurement (a node script in the container with the session cookie).
cookie=$(awk -F'\t' 'NF >= 7 { printf "%s=%s", $6, $7 }' "$jar")
evjs='const WebSocket=require("/opt/ccdash/dashboard/node_modules/ws");const fs=require("fs");
const ws=new WebSocket("ws://127.0.0.1:7690/events",{headers:{Cookie:process.env.C,Origin:"http://localhost:7690"}});
let n=0;ws.on("message",()=>{n++;fs.writeFileSync("/tmp/evcount",String(n))});ws.on("close",()=>process.exit(3));
setTimeout(()=>process.exit(0),Number(process.env.T)*1000)'
compose exec -d -T -u ccd -e "C=$cookie" -e T=900 ccdash node -e "$evjs"
ev_up() { [ "$(ccd cat /tmp/evcount 2>/dev/null || echo 0)" -ge 1 ]; }
until_ok 20 "an /events client is connected and receiving" ev_up
sleep 8 # let the first previews, token reads and the reconciler settle

# shellcheck disable=SC2016 # the sampling script runs in the container
# sample LABEL MAX_CPU_PCT: CPU % of one core and memory of the web user's node process over SAMPLE_SEC seconds.
sample() {
  local out
  out=$(compose exec -T -u root -e "N=$SAMPLE_SEC" ccdash sh -c '
    pid=$(pgrep -u web -f "node /opt/ccdash/dashboard/server.js" | head -n 1); [ -n "$pid" ] || exit 1
    tick=$(getconf CLK_TCK)
    cpu() { awk "{ sub(/^.*\\) /, \"\"); print \$12 + \$13 }" /proc/$pid/stat; }
    c0=$(cpu); t0=$(date +%s.%N); sleep "$N"; c1=$(cpu); t1=$(date +%s.%N)
    rss=$(awk "/^VmRSS/ { print \$2 }" /proc/$pid/status); hwm=$(awk "/^VmHWM/ { print \$2 }" /proc/$pid/status)
    awk -v a=$c0 -v b=$c1 -v t0=$t0 -v t1=$t1 -v k=$tick -v r=$rss -v h=$hwm -v p=$pid "BEGIN { printf \"pid=%s cpu_pct=%.2f secs=%.1f rss_mb=%.1f hwm_mb=%.1f\\n\", p, 100 * (b - a) / k / (t1 - t0), t1 - t0, r / 1024, h / 1024 }"')
  echo "     $1: $out"
  local cpu rss hwm secs
  cpu=$(sed -n 's/.*cpu_pct=\([0-9.]*\).*/\1/p' <<<"$out"); rss=$(sed -n 's/.*rss_mb=\([0-9.]*\).*/\1/p' <<<"$out")
  hwm=$(sed -n 's/.*hwm_mb=\([0-9.]*\).*/\1/p' <<<"$out"); secs=$(sed -n 's/.*secs=\([0-9.]*\).*/\1/p' <<<"$out")
  if awk -v s="$secs" 'BEGIN { exit !(s >= 30) }'; then ok "$1: sampled for ${secs}s (>= 30)"; else bad "$1: sampled for only ${secs:-?}s"; fi
  if awk -v c="$cpu" -v m="$2" 'BEGIN { exit !(c < m) }'; then ok "$1: CPU $cpu % of one core (< $2 %)"; else bad "$1: CPU $cpu % (limit $2 %)"; fi
  if awk -v r="$hwm" 'BEGIN { exit !(r < 200) }'; then ok "$1: RSS ${rss} MB, peak ${hwm} MB (< 200 MB)"; else bad "$1: RSS ${rss} MB, peak ${hwm} MB (limit 200 MB)"; fi
}
echo "== load: idle, 10 conversations, one /events client"
sample idle 3
echo "== load: active, fake claudes appending to statuslines and transcripts"
# Roughly 2.5 turns a second across the ten conversations, every other one a /status (a usage reading), typed
# into the panes with tmux so the only dashboard work measured is reacting to what the fake claudes write.
active() { local n=0 i; while :; do n=$((n + 1)); i=$((n % 10 + 1))
    tm send-keys -t "=claude-l$i:" "$( [ $((n % 2)) = 0 ] && echo /status || echo "turn $n")" Enter || true
    sleep 0.4; done; }
prompts_n() { ccd sh -c 'ls /home/ccd/.fake-claude/prompts | wc -l'; }
p0=$(prompts_n)
active >/dev/null 2>&1 &
bg=$!
sample active "$ACTIVE_MAX_CPU"
kill "$bg" 2>/dev/null || true; wait "$bg" 2>/dev/null || true; bg=""
p1=$(prompts_n)
echo "     the fake claudes took $((p1 - p0)) prompts during the active sample"
if [ $((p1 - p0)) -ge 40 ]; then ok "the active sample really was active"; else bad "only $((p1 - p0)) prompts reached the fake claudes"; fi
ev_n=$(ccd cat /tmp/evcount || echo 0)
echo "     the /events client received $ev_n messages in all"

echo "== browser (Playwright, headless Chromium at 390x844 and 1280x800)"
for i in 1 2 3 4 5 6 7 8 9 10; do until_ok 30 "l$i is waiting (quiet before the browser)" is_status "l$i" waiting; done
# idle flips (waiting -> idle after CCDASH_IDLE_FLAG) push /events state changes that make the cards reload the list; let them all land first
for i in 1 2 3 4 5 6 7 8 9 10; do until_ok 30 "l$i is idle (flag flipped before the browser)" is_idle "l$i"; done
sleep 8
PW_RC=0
$D rm -f "$PW_NAME" >/dev/null 2>&1 || true
$D run --name "$PW_NAME" --network "container:$cid" --ipc=host \
  -e CCDASH_URL=$origin -e CCDASH_USER=t -e CCDASH_PASS=test-password-123 -e OUT_DIR=/out \
  -e EXPECT_GAUGES=unknown -e SUB_PROJECT=l1 -e MIN_CARDS=10 -e IDLE_SEC=15 "$PW_IMAGE" npm run test:e || PW_RC=$?
mkdir -p "$tmp/shots"
$D cp "$PW_NAME:/out/." - 2>/dev/null | tar -x -C "$tmp/shots" 2>/dev/null || true # a tar stream: the Docker user may not own the directory
$D rm -f "$PW_NAME" >/dev/null 2>&1 || true
if [ "$PW_RC" = 0 ]; then ok "Playwright specs passed"; else bad "Playwright specs failed (exit $PW_RC)"; fi
mkdir -p "$SHOTS" && cp "$tmp"/shots/*.png "$SHOTS"/ 2>/dev/null && echo "screenshots in $SHOTS: $(find "$SHOTS" -maxdepth 1 -name '*.png' -printf '%f ' | head -c 600)" || true
fi # load
exit $fail
