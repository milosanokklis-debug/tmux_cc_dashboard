#!/usr/bin/env bash
# Replays every fixture through the hook commands in managed-settings.json (scratch HOME), and
# validates fixtures for events that are not configured. Exit nonzero on any failure.
set -uo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixtures=${FIXTURES_DIR:-$root/tests/fixtures/2.1.317}
settings=${SETTINGS:-$root/rootfs/etc/claude-code/managed-settings.json}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
expected=${REPLAY_EXPECTED:-$root/tests/replay/expected}
# Hooks write only under $HOME/.ccdash; TMUX_PANE stays unset so they never touch tmux.
export HOME=$tmp/home CCDASH_TMUX=$tmp/none.sock CLAUDE_PROJECT_DIR=/workspace/_h2probe
unset TMUX_PANE
mkdir -p "$HOME"

fail=0
for f in "$fixtures"/*.json; do
  name=$(basename "$f" .json)
  [ "$name" = statusline ] && continue
  ev=$(jq -r '.hook_event_name // empty' "$f" 2>/dev/null)
  if [ -z "$ev" ] || [ "${name%%-*}" != "$ev" ]; then
    echo "FAIL $name: hook_event_name '$ev' does not match filename"; fail=1; continue
  fi
  # only the payloads captured from the real 2.1.317 may omit the synthetic flag
  case $name in SessionStart | UserPromptSubmit | Stop | SubagentStart | SubagentStop | SessionEnd) ;;
    *) if [ "$(jq -r '.synthetic // false' "$f")" != true ]; then
         echo "FAIL $name: synthetic fixture lacks \"synthetic\": true"; fail=1; continue
       fi ;;
  esac
  cmds=$(jq -r --arg e "$ev" '.hooks[$e][]?.hooks[]? | select(.type=="command") | .command' "$settings")
  if [ -z "$cmds" ]; then
    echo "PASS $name (valid, event $ev not configured)"; continue
  fi
  ok=1
  while IFS= read -r cmd; do
    # the installed path /usr/local/lib/ccdash is rootfs/usr/local/lib/ccdash in the repo
    [ -e /usr/local/lib/ccdash ] || cmd=${cmd//\/usr\/local\/lib\/ccdash/$root/rootfs/usr/local/lib/ccdash}
    if ! timeout "${REPLAY_TIMEOUT:-10}" bash -c "$cmd" <"$f" >"$tmp/out" 2>&1; then
      echo "FAIL $name: '$cmd' exited nonzero"; cat "$tmp/out"; ok=0
    fi
  done <<<"$cmds"
  if [ $ok -eq 1 ]; then echo "PASS $name (replayed through hooks)"; else fail=1; fi
done
# the real SessionStart payload must have produced an agents record
if [ -z "$(ls "$HOME/.ccdash/agents" 2>/dev/null)" ]; then echo "FAIL no agent record written"; fail=1; fi
# State diff: one snapshot of $HOME/.ccdash per run (sorted paths, volatile values normalised),
# compared with the committed tests/replay/expected/state.txt. REPLAY_UPDATE=1 rewrites it.
snap() {
  (cd "$HOME/.ccdash" && find . -type f | LC_ALL=C sort | while IFS= read -r x; do
    echo "== $x"
    sed -E -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z/<ISO-TS>/g' \
      -e 's/("ts": )[0-9]+/\1<TS>/g' -e "s#$tmp#<TMP>#g" "$x"
  done)
}
if [ "${REPLAY_UPDATE:-}" = 1 ]; then
  mkdir -p "$expected" && snap >"$expected/state.txt" && echo "updated $expected/state.txt"
elif [ ! -f "$expected/state.txt" ]; then
  echo "FAIL state diff: $expected/state.txt (missing expected file; REPLAY_UPDATE=1 creates it)"; fail=1
else
  snap >"$tmp/state.txt"
  if ! d=$(diff -u "$expected/state.txt" "$tmp/state.txt"); then
    echo "FAIL state diff: state.txt"; echo "$d"; fail=1
  fi
fi
exit $fail
