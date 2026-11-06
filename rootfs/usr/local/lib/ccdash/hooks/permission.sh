#!/usr/bin/env bash
# PermissionRequest hook. Marks the conversation needs_approval, then asks the dashboard broker for a
# decision (the user clicks Approve or Deny). Any failure, a timeout or a missing broker means: exit 0 with
# no output, so Claude shows its own terminal dialog. Prints only a validated allow or deny.
set -uo pipefail
exec 2>/dev/null
if ! command -v jq >/dev/null 2>&1; then cat >/dev/null; exit 0; fi
in=$(cat) || exit 0
here=${BASH_SOURCE[0]%/*}
state=$here/state.sh
[ -x "$state" ] || state=/usr/local/lib/ccdash/hooks/state.sh
"$state" needs_approval <<<"$in" || true
wait=${CCDASH_APPROVAL_WAIT:-120}
[[ $wait =~ ^[0-9]+$ ]] && [ "$wait" -gt 0 ] || wait=120
body=$(jq -c --arg pane "${TMUX_PANE:-}" '. + {pane: $pane}' <<<"$in") || exit 0
resp=$(curl -sf --max-time "$wait" --unix-socket "${CCDASH_BROKER_SOCK:-/run/ccdash-web/broker.sock}" \
  -H 'content-type: application/json' --data-binary @- http://broker/permission <<<"$body") || exit 0
# exactly {behavior: allow|deny} plus an optional string message (kept for deny only); anything else is ignored
out=$(jq -ce '
  if type == "object" and ((keys - ["behavior", "message"]) | length) == 0
     and (.behavior == "allow" or .behavior == "deny")
     and ((has("message") | not) or (.message | type) == "string")
  then {hookSpecificOutput: {hookEventName: "PermissionRequest",
        decision: ({behavior: .behavior}
                   + (if .behavior == "deny" and (.message // "") != "" then {message: .message} else {} end))}}
  else empty end' <<<"$resp") || exit 0
[ -n "$out" ] && printf '%s\n' "$out"
exit 0
