#!/usr/bin/env bats
# Window commands (step 2 of docs/handoff/project-sessions.md): ccd-session windows|new|close, agents hook removed.
# 
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
  export CCDASH_ACCOUNTS_LIB=$LIB CCDASH_KIT_LIB=$LIB
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

@test "AC-2.1 windows prints one JSON line per window with id, index, name, active and kind" {
  logged_in a
  run "$S" start a; [ "$status" -eq 0 ]
  run "$S" new a shell; [ "$status" -eq 0 ]
  run "$S" login a; [ "$status" -eq 0 ]
  run "$S" windows a
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 3 ]
  for l in "${lines[@]}"; do
    jq -e '(.id|test("^@[0-9]+$")) and (.index|type=="number") and (.name|type=="string") and has("active") and has("pid")' <<<"$l"
  done
  [ "$(jq -r .kind <<<"$output" | sort | tr '\n' ' ')" = "claude login shell " ]
  [ "$(jq -r 'select(.kind=="login").name' <<<"$output")" = login ]
  [ "$(jq -r 'select(.active==true).id' <<<"$output" | wc -l)" -eq 1 ]
}

@test "AC-2.1 windows ids match tmux's window ids" {
  logged_in a
  "$S" start a
  "$S" new a shell
  [ "$(ids a)" = "$(tm list-windows -t =claude-a -F '#{window_id}' | sort)" ]
}

@test "AC-2.2 new shell and new claude each print a new id that shows in windows" {
  logged_in a
  "$S" start a
  before=$(ids a)
  run "$S" new a shell
  [ "$status" -eq 0 ]
  [[ $output =~ ^@[0-9]+$ ]]
  s=$output
  run "$S" new a claude
  [ "$status" -eq 0 ]
  [[ $output =~ ^@[0-9]+$ ]]
  c=$output
  [ "$s" != "$c" ]
  [[ $before != *"$s"* && $before != *"$c"* ]]
  [ "$(wins a | jq -r --arg i "$s" 'select(.id==$i).kind')" = shell ]
  [ "$(wins a | jq -r --arg i "$c" 'select(.id==$i).kind')" = claude ]
}

@test "AC-2.2 new claude on a logged-out project exits 9 and adds no window" {
  run "$S" new b claude
  [ "$status" -eq 9 ]
  [ ! -s "$BATS_TEST_TMPDIR/started" ]
  [ -z "$(tm list-windows -t =claude-b -F x 2>/dev/null)" ]
}

@test "AC-2.2 new with a bad kind exits 2" {
  logged_in a
  "$S" start a
  run "$S" new a shell
  [ "$status" -eq 0 ]
  run "$S" new a bogus
  [ "$status" -eq 2 ]
  [ "$(wins a | wc -l)" -eq 2 ]
}

@test "AC-2.3 close on a claude window pastes /exit first, then kills it after CCDASH_CLOSE_WAIT" {
  logged_in a
  # claude that records what it reads from the terminal and then ignores it
  printf '#!/bin/bash\nif [ "${1:-}" = mcp ] || [ "${1:-} ${2:-}" = "auth status" ]; then exec %q "$@"; fi\nread -r line\nprintf "%%s\\n" "$line" >>%q\nsleep 30\n' \
    "$ROOT/tests/fake-claude/claude" "$BATS_TEST_TMPDIR/typed" >"$HOME/bin/claude"
  "$S" start a
  "$S" new a shell
  c=$(wins a | jq -r 'select(.kind=="claude").id')
  [ -n "$c" ]
  run "$S" close a "$c"
  [ "$status" -eq 0 ]
  grep -qx '/exit' "$BATS_TEST_TMPDIR/typed"
  [[ $(ids a) != *"$c"* ]]
  [ "$(wins a | wc -l)" -eq 1 ]
}

@test "AC-2.3 close on a shell window kills it right away" {
  logged_in a
  export CCDASH_CLOSE_WAIT=20
  "$S" start a
  s=$("$S" new a shell)
  SECONDS=0
  run "$S" close a "$s"
  [ "$status" -eq 0 ]
  [ "$SECONDS" -lt 10 ]
  [[ $(ids a) != *"$s"* ]]
  [ "$(wins a | wc -l)" -eq 1 ]
}

@test "AC-2.3 close refuses a window id of another project: exit 1, b's window survives" {
  logged_in a; logged_in b
  "$S" start a
  "$S" start b
  bw=$(wins b | jq -r .id)
  run "$S" close a "$bw"
  [ "$status" -eq 1 ]
  [ "$(ids b)" = "$bw" ]
  [ "$(wins a | wc -l)" -eq 1 ]
}

@test "AC-2.4 no hook in the managed settings calls agents.sh" {
  f=$ROOT/rootfs/etc/claude-code/managed-settings.json
  [ -f "$f" ]
  jq -e . "$f" >/dev/null
  ! grep -q 'agents\.sh' "$f"
  [ "$(jq '[.hooks[][].hooks[].command] | map(select(test("agents")))| length' "$f")" -eq 0 ]
}

@test "AC-2.4 agents.sh no longer exists" {
  [ ! -e "$LIB/hooks/agents.sh" ]
  [ -z "$(find "$ROOT/rootfs" -name 'agents.sh')" ]
}
