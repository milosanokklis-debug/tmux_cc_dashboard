#!/usr/bin/env bats
# Review regressions for ccd-session windows|close.
setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  LIB=$ROOT/rootfs/usr/local/lib/ccdash
  BIN=$ROOT/rootfs/usr/local/bin
  export HOME=$BATS_TEST_TMPDIR/home
  export CCDASH_WS=$BATS_TEST_TMPDIR/ws
  export CCDASH_TMUX=$BATS_TEST_TMPDIR/tmux.sock
  export CCDASH_STATE=$HOME/.ccdash/sessions
  export CCDASH_PROJECTS=$HOME/.ccdash/projects
  export FAKE_CLAUDE_HOME=$BATS_TEST_TMPDIR/fake
  export FAKE_CLAUDE_SETTINGS=/nonexistent FAKE_CLAUDE_MCP=connected CCDASH_MCP_TIMEOUT=5
  export CCDASH_PROJECT_LIB=$LIB CCDASH_KIT_LIB=$LIB
  export CCDASH_CLOSE_WAIT=1
  export CCDASH_CONFIG_ROOT=$BATS_TEST_TMPDIR/projects
  mkdir -p "$HOME/bin" "$CCDASH_WS/a" "$CCDASH_WS/b" "$CCDASH_STATE" "$CCDASH_PROJECTS" "$FAKE_CLAUDE_HOME"
  # claude wrapper: mcp and `auth status` go to the fake; any other start is logged as "<config dir> <args>" and waits
  printf '#!/bin/bash\nif [ "${1:-}" = mcp ] || [ "${1:-} ${2:-}" = "auth status" ]; then exec %q "$@"; fi\nprintf "%%s\\n" "${CLAUDE_CONFIG_DIR:-unset} $*" >>%q\nsleep 30\n' \
    "$ROOT/tests/fake-claude/claude" "$BATS_TEST_TMPDIR/started" >"$HOME/bin/claude"
  chmod +x "$HOME/bin/claude"
  export PATH=$HOME/bin:$PATH
  printf 'export PATH=%s/bin:$PATH\n' "$HOME" >"$HOME/.bash_profile"
  unset TMUX TMUX_PANE CLAUDE_CONFIG_DIR
  S=$BIN/ccd-session
}

teardown() { tmux -S "$CCDASH_TMUX" kill-server 2>/dev/null || true; }

tm() { tmux -S "$CCDASH_TMUX" "$@"; }
logged_in() { mkdir -p "$FAKE_CLAUDE_HOME/accounts/$1"; : >"$FAKE_CLAUDE_HOME/accounts/$1/logged-in"; }
started() { for _ in $(seq 50); do [ "$(wc -l <"$BATS_TEST_TMPDIR/started" 2>/dev/null || echo 0)" -ge "$1" ] && return 0; sleep 0.1; done; cat "$BATS_TEST_TMPDIR/started" 2>/dev/null; return 1; }


wins() { "$S" windows "$1"; }
ids() { wins "$1" | jq -r .id | sort; }
# claude stand-in: mcp/auth go to the fake; otherwise reads one line from the terminal, exits on /exit, else sleeps
fake_claude() {
  printf '#!/bin/bash\nif [ "${1:-}" = mcp ] || [ "${1:-} ${2:-}" = "auth status" ]; then exec %q "$@"; fi\nread -r line\nprintf "%%s\\n" "$line" >>%q\n[ "$line" = /exit ] && exit 0\nsleep 30\n' \
    "$ROOT/tests/fake-claude/claude" "$BATS_TEST_TMPDIR/typed" >"$HOME/bin/claude"
}

@test "windows: a window without @kind lists as kind shell, other fields intact" {
  logged_in a
  "$S" start a
  tm new-window -d -t =claude-a: -n plain bash -l
  run "$S" windows a
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 2 ]
  l=$(jq -c 'select(.name=="plain")' <<<"$output")
  [ -n "$l" ]
  [ "$(jq -r .kind <<<"$l")" = shell ]
  jq -e '(.id|test("^@[0-9]+$")) and (.index|type=="number") and (.active==false) and (.pid|type=="number" and . > 0)' <<<"$l"
}

@test "windows: a window name with a tab is kept whole and later fields do not shift" {
  logged_in a
  "$S" start a
  tm new-window -d -t =claude-a: -n $'we\tird' bash -l
  w=$(tm list-windows -t =claude-a: -F '#{window_id}' | tail -n 1)
  tm set -w -t "$w" @kind shell
  run "$S" windows a
  [ "$status" -eq 0 ]
  l=$(jq -c --arg i "$w" 'select(.id==$i)' <<<"$output")
  [ -n "$l" ]
  [ "$(jq -r .name <<<"$l")" = $'we\tird' ]
  [ "$(jq -r .kind <<<"$l")" = shell ]
  [ "$(jq -r .active <<<"$l")" = false ]
  [ "$(jq -r '.pid > 0' <<<"$l")" = true ]
}

@test "close: @kind=claude window whose command is not claude gets no /exit and is killed at once" {
  logged_in a
  export CCDASH_CLOSE_WAIT=20
  "$S" start a
  tm new-window -d -t =claude-a: -n fake "read -r l; printf '%s\\n' \"\$l\" >>$BATS_TEST_TMPDIR/typed; sleep 30"
  w=$(tm list-windows -t =claude-a: -F '#{window_id}' | tail -n 1)
  tm set -w -t "$w" @kind claude
  SECONDS=0
  run "$S" close a "$w"
  [ "$status" -eq 0 ]
  [ "$SECONDS" -lt 5 ]
  [[ $(ids a) != *"$w"* ]]
  [ ! -s "$BATS_TEST_TMPDIR/typed" ]
}

@test "close: returns as soon as claude exits after /exit, not after CCDASH_CLOSE_WAIT" {
  logged_in a
  export CCDASH_CLOSE_WAIT=20
  fake_claude
  "$S" start a
  c=$(wins a | jq -r 'select(.kind=="claude").id')
  [ -n "$c" ]
  for _ in $(seq 50); do [ "$(tm display -p -t "$c" '#{pane_current_command}')" = claude ] && break; sleep 0.1; done
  SECONDS=0
  run "$S" close a "$c"
  [ "$status" -eq 0 ]
  [ "$SECONDS" -lt 5 ]
  grep -qx '/exit' "$BATS_TEST_TMPDIR/typed"
  [[ $(ids a) != *"$c"* ]]
}
