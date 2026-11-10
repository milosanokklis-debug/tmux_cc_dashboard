#!/usr/bin/env bash
# Claude Code statusLine command. Records {sid, ts, rate_limits, cost, context_window, model} in
# ~/.ccdash/usage/<session_id>.json (keyed by project: the first directory below the workspace of CLAUDE_PROJECT_DIR, else the cwd; empty outside it; atomic, umask 027) for the dashboard's usage gauges, then
# prints the status line: $CCDASH_STATUSLINE_CMD (payload on its stdin) if set, else
# "<model> · ctx <used_percentage or ?>%". Must never fail Claude: every path exits 0.
# A hidden helper Claude (CCDASH_HIDDEN=1) records nothing.
set -uo pipefail
umask 027
base=${HOME:-/tmp}/.ccdash
mkdir -p "$base" 2>/dev/null
# shellcheck source=/dev/null
. "${BASH_SOURCE[0]%/*}/project-of.sh"
in=$(cat)

record() {
  [ "${CCDASH_HIDDEN:-}" = 1 ] && return 0
  command -v jq >/dev/null 2>&1 || return 0
  local sid dir tmp pdir
  sid=$(jq -r '.session_id // empty' <<<"$in") || return 0
  [[ $sid =~ ^[A-Za-z0-9_-]+$ ]] || return 0
  pdir=$(project_of "${CLAUDE_PROJECT_DIR:-$(jq -r '.cwd // empty' <<<"$in")}")
  dir=$base/usage
  mkdir -p "$dir" 2>/dev/null || return 0
  tmp=$(mktemp "$dir/.$sid.XXXXXX" 2>/dev/null) || return 0
  if jq -c --arg proj "$pdir" --argjson now "$(date +%s)" \
        '{sid: .session_id, project: $proj, ts: $now, rate_limits: (.rate_limits // null), cost: (.cost // null),
          context_window: (.context_window // null), model: (.model // null)}' <<<"$in" >"$tmp" \
     && chmod 0640 "$tmp" && mv -f "$tmp" "$dir/$sid.json"; then
    :
  else
    rm -f "$tmp"
  fi
}

# keep hook.log small: start over when it passes 256 KB
if [ "$(stat -c %s "$base/hook.log" 2>/dev/null || echo 0)" -gt 262144 ]; then : >"$base/hook.log" 2>/dev/null || true; fi
# readings older than 7 days go, checked at most once a day (the dashboard runs as web and cannot delete)
if [ -d "$base/usage" ] && [ -z "$(find "$base/.pruned" -mmin -1440 2>/dev/null)" ]; then
  find "$base/usage" -maxdepth 1 -name '*.json' -mtime +7 -delete 2>/dev/null; touch "$base/.pruned" 2>/dev/null
fi
record 2>>"$base/hook.log" || true

if [ -n "${CCDASH_STATUSLINE_CMD:-}" ]; then
  printf '%s' "$in" | bash -c "$CCDASH_STATUSLINE_CMD" || true
elif command -v jq >/dev/null 2>&1; then
  jq -r '"\(.model.display_name // "?") · ctx \(.context_window.used_percentage // "?")%"' <<<"$in" 2>/dev/null || echo "? · ctx ?%"
else
  echo "? · ctx ?%"
fi
exit 0
