# shellcheck shell=bash
# shellcheck disable=SC2154 # $url, $jar, $root, $origin come from the sourcing script
# Sourced by the stack scripts. Needs the caller's `ccd` function (runs a command as ccd in the
# stack container) and `ok`/`bad`.
#
# stack_login PROJECT: signs the project in through the fake claude. `ccd-session login` opens the
# window `login` running `claude auth login` (prints a URL, waits for a code line); a code line sent
# with tmux send-keys marks the project's config dir logged in. Polls `ccd-session auth` for
# logged-in (30 s), else prints a FAIL line and returns 1. The project dir must exist.
stack_login() {
  local p=$1 s=claude-${1//[^[:alnum:]_-]/_} i
  if [ "$(ccd ccd-session auth "$p" 2>/dev/null)" = logged-in ]; then return 0; fi
  ccd ccd-session login "$p" >/dev/null || { echo "FAIL stack_login $p: ccd-session login failed"; return 1; }
  for i in $(seq 150); do
    if [ "$(ccd ccd-session auth "$p" 2>/dev/null)" = logged-in ]; then return 0; fi
    # resend each round: the fake only reads stdin once it has printed the URL
    if [ $((i % 5)) = 1 ]; then ccd tmux -S /run/ccdash/tmux.sock send-keys -t "=$s:=login" code123 Enter >/dev/null 2>&1 || true; fi
    sleep 0.2
  done
  echo "FAIL stack_login $p: still logged-out after 30 s"
  return 1
}

# stack_states: the conversations as one JSON array ({sid, project, status, idle?, approval?}), taken
# from the first state message on /events (GET /api/tree is gone). Needs $url, $jar and $root.
stack_states() {
  local ck
  ck=$(awk '$6 == "__Host-ccdash" { printf "%s=%s", $6, $7 }' "$jar")
  node -e '
const { WebSocket } = require(process.argv[1]);
const [, , wsUrl, origin, cookie] = process.argv;
const ws = new WebSocket(wsUrl, { headers: { origin, cookie } });
const bail = setTimeout(() => process.exit(1), 5000);
ws.on("error", () => process.exit(1));
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type !== "state") return;
  clearTimeout(bail);
  console.log(JSON.stringify(Object.entries(m.states).map(([sid, v]) => ({ sid, ...v }))));
  ws.terminate();
});' "$root/dashboard/node_modules/ws" "ws${url#http}/events" "${origin:-http://localhost:7690}" "$ck"
}

# live PROJECT JQ_EXPR: JQ_EXPR applied to the project's first conversation that is not ended or sleeping.
live() { stack_states | jq -r --arg p "$1" '[.[] | select(.project == $p and .status != "ended" and .status != "sleeping")][0] | '"$2"; }

# An abort under `set -e` names the failing step instead of ending silently.
_nl=$'\n'
set -E
# Only a failure in the script's own shell counts: not one inside $(...) or a subshell, and (as bash
# itself decides) not one in an `if`/`||`/`&&` list.
trap 'rc=$?; [ "$BASH_SUBSHELL" = 0 ] && { echo "FAIL aborted: line $LINENO: ${BASH_COMMAND%%$_nl*} (exit $rc)"; fail=1; }' ERR
