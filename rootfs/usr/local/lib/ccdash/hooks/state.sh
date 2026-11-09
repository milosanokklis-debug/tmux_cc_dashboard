#!/usr/bin/env bash
# Records the conversation state (working, needs_approval, waiting, error, ended) per session id
# in ~/.ccdash/sessions/<sid>.json. Must never block or fail Claude: every path exits 0.
set -uo pipefail
# shellcheck source=/dev/null
. "${CCDASH_ACCOUNTS_LIB:-${BASH_SOURCE[0]%/*}/..}/accounts.sh" 2>/dev/null || account_of_config_dir() { echo default; }
# a hidden helper Claude (CCDASH_HIDDEN=1, the /usage fallback) is not a conversation
if [ "${CCDASH_HIDDEN:-}" = 1 ]; then cat >/dev/null; exit 0; fi
umask 027
base=${HOME:-/tmp}/.ccdash
dir=$base/sessions
mkdir -p "$dir" 2>/dev/null || exit 0
exec 2>>"$base/hook.log"
# jq missing (or broken): drain stdin and do nothing, so Claude shows no hook error
if ! command -v jq >/dev/null 2>&1; then cat >/dev/null; exit 0; fi
in=$(cat)
sid=$(jq -r '.session_id // empty' <<<"$in") || exit 0
[ -n "$sid" ] || exit 0
[[ $sid =~ ^[A-Za-z0-9_-]+$ ]] || exit 0
f=$dir/$sid.json
prev='{}'
if [ -s "$f" ]; then
  prev=$(cat "$f" 2>/dev/null) || prev='{}'
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$prev" || prev='{}'
fi
# tmux server pid and start time. The pid alone is not enough: in a container a restarted
# server gets the same pid again, and pane ids start again at %0.
srv="" start=""
if [ -n "${TMUX:-}" ]; then
  read -r srv start < <(tmux -S "${CCDASH_TMUX:-/run/ccdash/tmux.sock}" display -p -t "${TMUX_PANE:-}" '#{pid} #{start_time}' 2>/dev/null || true)
  [[ ${srv:-} =~ ^[0-9]+$ && ${start:-} =~ ^[0-9]+$ ]] || { srv=""; start=""; }
fi
# the account comes from the config dir: unset or anything else is `default`
acct=$(account_of_config_dir)
tmp=$(mktemp "$dir/.$sid.XXXXXX" 2>/dev/null) || exit 0
# the payload goes in on stdin (an argv string is capped at 128 KB, and PostToolUse can be larger)
if jq --argjson prev "$prev" --arg state "${1:-}" \
      --arg pane "${TMUX_PANE:-}" --arg srv "$srv" --arg start "$start" --arg proj "${CLAUDE_PROJECT_DIR:-}" \
      --arg acct "$acct" --arg from "${CCDASH_RESUMED_FROM:-}" --argjson now "$(date +%s)" '
  . as $in | $prev + {
    sid: $in.session_id,
    project: ($prev.project // (if $proj != "" then $proj else $in.cwd end)),
    transcript: $in.transcript_path,
    account: $acct,
    state: $state, event: $in.hook_event_name, ts: $now,
    pane: (if $pane != "" then $pane else $prev.pane end),
    tmux_pid: (if $srv != "" then ($srv | tonumber) else $prev.tmux_pid end),
    tmux_start: (if $start != "" then ($start | tonumber) else $prev.tmux_start end),
    waiting_since: (if $state == "waiting"
                    then (if $prev.state == "waiting" then $prev.waiting_since else $now end)
                    else null end)
  } + (if $from != "" then {resumed_from: $from} else {} end)' <<<"$in" >"$tmp" \
   && chmod 0640 "$tmp" && mv -f "$tmp" "$f"; then
  :
else
  rm -f "$tmp"
fi
exit 0
