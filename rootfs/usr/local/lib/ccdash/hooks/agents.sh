#!/usr/bin/env bash
# Records Claude Code session/subagent events. Must never block or fail Claude.
set -uo pipefail
# a hidden helper Claude (CCDASH_HIDDEN=1, the /usage fallback) is not a conversation
if [ "${CCDASH_HIDDEN:-}" = 1 ]; then cat >/dev/null; exit 0; fi
umask 027
ev=${1:-}
d=${HOME:-/tmp}/.ccdash/agents
mkdir -p "$d" 2>/dev/null || exit 0
exec 2>>"${HOME:-/tmp}/.ccdash/hook.log"
command -v jq >/dev/null 2>&1 || exit 0
in=$(cat)
sid=$(jq -r '.session_id // empty' <<<"$in") || exit 0
[ -n "$sid" ] || exit 0
[[ $sid =~ ^[A-Za-z0-9_-]+$ ]] || exit 0
win=
if [ -n "${TMUX_PANE:-}" ]; then
  win=$(tmux -S "${CCDASH_TMUX:-/run/ccdash/tmux.sock}" display -p -t "$TMUX_PANE" '#{session_name}:#{window_index}' 2>/dev/null) || win=
fi
jq -c --arg ev "$ev" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg sid "$sid" \
  --arg pane "${TMUX_PANE:-}" --arg win "$win" --arg proj "${CLAUDE_PROJECT_DIR:-}" '
  {ev:$ev, ts:$ts, sid:$sid, pane:$pane, win:$win,
   project:(if $proj != "" then $proj else (.cwd // "") end),
   agent_id:(.agent_id // null), agent_type:(.agent_type // null),
   agent_transcript:(.agent_transcript_path // null)}' <<<"$in" >>"$d/$sid.jsonl" || true
exit 0
