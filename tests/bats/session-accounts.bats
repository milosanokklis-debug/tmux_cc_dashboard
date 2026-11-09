#!/usr/bin/env bats
# ccd-session per account: --account parsing, CLAUDE_CONFIG_DIR into tmux, the gate per dir,
# one window per account, wake with the recorded account, state.sh recording the account.

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  BIN=$ROOT/rootfs/usr/local/bin
  export HOME=$BATS_TEST_TMPDIR/home
  export CCDASH_WS=$BATS_TEST_TMPDIR/ws
  export CCDASH_TMUX=$BATS_TEST_TMPDIR/tmux.sock
  export CCDASH_STATE=$HOME/.ccdash/sessions
  export FAKE_CLAUDE_HOME=$BATS_TEST_TMPDIR/fake
  export FAKE_CLAUDE_SETTINGS=/nonexistent FAKE_CLAUDE_MCP=connected CCDASH_MCP_TIMEOUT=5
  export CCDASH_ACCOUNTS_LIB=$ROOT/rootfs/usr/local/lib/ccdash CCDASH_ACCOUNTS_DIR=$BATS_TEST_TMPDIR/accounts
  mkdir -p "$HOME/bin" "$CCDASH_WS/demo" "$CCDASH_STATE" "$CCDASH_ACCOUNTS_DIR/work" "$CCDASH_ACCOUNTS_DIR/alt"
  # a claude that records the config dir it was started with, then waits
  printf '#!/bin/bash\nif [ "${1:-}" = mcp ]; then exec %q "$@"; fi\nprintf "%%s\\n" "${CLAUDE_CONFIG_DIR:-unset} $*" >>%q\nsleep 30\n' \
    "$ROOT/tests/fake-claude/claude" "$BATS_TEST_TMPDIR/started" >"$HOME/bin/claude"
  chmod +x "$HOME/bin/claude"
  export PATH=$HOME/bin:$PATH
  printf 'export PATH=%s/bin:$PATH\n' "$HOME" >"$HOME/.bash_profile"
  unset TMUX TMUX_PANE CLAUDE_CONFIG_DIR
  S=$BIN/ccd-session
}

teardown() { tmux -S "$CCDASH_TMUX" kill-server 2>/dev/null || true; }

tm() { tmux -S "$CCDASH_TMUX" "$@"; }
wins() { tm list-windows -t =claude-demo -F '#{@account}' | sort | tr '\n' ' '; }
nwin() { tm list-windows -t =claude-demo | wc -l; }
started() { for _ in $(seq 50); do [ "$(wc -l <"$BATS_TEST_TMPDIR/started" 2>/dev/null || echo 0)" -ge "$1" ] && return 0; sleep 0.1; done; cat "$BATS_TEST_TMPDIR/started"; return 1; }

@test "no --account: as before, default account, no CLAUDE_CONFIG_DIR" {
  run "$S" start demo
  [ "$status" -eq 0 ] && [ "$output" = claude-demo ]
  started 1
  grep -q '^unset ' "$BATS_TEST_TMPDIR/started"
  [ "$(wins)" = "default " ]
}

@test "--account puts CLAUDE_CONFIG_DIR in the pane and marks the window" {
  run "$S" start demo --account work
  [ "$status" -eq 0 ]
  started 1
  grep -q "^$CCDASH_ACCOUNTS_DIR/work " "$BATS_TEST_TMPDIR/started"
  [ "$(wins)" = "work " ]
}

@test "the gate runs with the account's config dir" {
  # work has no registered basic-memory, alt does
  FAKE_CLAUDE_MCP=none run "$S" start demo --account work
  [ "$status" -eq 7 ]
  mkdir -p "$FAKE_CLAUDE_HOME/accounts/alt"; : >"$FAKE_CLAUDE_HOME/accounts/alt/mcp-registered"
  FAKE_CLAUDE_MCP=none run "$S" start demo --account alt
  [ "$status" -eq 0 ]
}

@test "a second account opens a new window; the same account reuses its window" {
  "$S" start demo
  [ "$(nwin)" -eq 1 ]
  "$S" start demo --account work
  [ "$(nwin)" -eq 2 ]
  [ "$(wins)" = "default work " ]
  "$S" start demo --account work
  "$S" start demo
  "$S" attach demo --account work </dev/null >/dev/null 2>&1 || true
  [ "$(nwin)" -eq 2 ]
}

@test "starting an account that has a window selects that window" {
  "$S" start demo
  "$S" start demo --account work
  "$S" start demo
  [ "$(tm display -p -t =claude-demo: '#{@account}')" = default ]
  "$S" start demo --account work
  [ "$(tm display -p -t =claude-demo: '#{@account}')" = work ]
  [ "$(nwin)" -eq 2 ]
}

@test "the gate runs before a new window, and a refusal opens nothing" {
  "$S" start demo
  FAKE_CLAUDE_MCP=none run "$S" start demo --account work
  [ "$status" -eq 7 ]
  [ "$(nwin)" -eq 1 ]
}

@test "a window without @account counts as default" {
  tm new-session -d -s claude-demo -c "$CCDASH_WS/demo" 'sleep 30'
  tm set -t =claude-demo: @project_dir "$CCDASH_WS/demo"
  FAKE_CLAUDE_MCP=none "$S" start demo # would be refused by the gate if it tried a window
  [ "$(nwin)" -eq 1 ]
}

@test "bad and unknown account names are refused, nothing started" {
  for bad in Work ../x a/b '' 'a.b'; do
    run "$S" start demo --account "$bad"
    [ "$status" -ne 0 ] || { echo "accepted $bad"; false; }
  done
  run "$S" start demo --account
  [ "$status" -ne 0 ]
  run "$S" start demo --account nosuch
  [ "$status" -eq 1 ]
  [[ $output == *"unknown account"* ]]
  run "$S" attach demo --account nosuch
  [ "$status" -ne 0 ]
  ! tm has-session -t =claude-demo 2>/dev/null
}

@test "a prompt starting with - is never a flag; only a leading --account is read" {
  run "$S" start demo -- -x
  [ "$status" -eq 0 ]
  started 1
  grep -q -- ' -- -x$' "$BATS_TEST_TMPDIR/started"
  tm kill-server
  rm -f "$BATS_TEST_TMPDIR/started"
  run "$S" start demo --account work -x
  [ "$status" -eq 0 ]
  started 1
  grep -q -- "^$CCDASH_ACCOUNTS_DIR/work -- -x$" "$BATS_TEST_TMPDIR/started"
  tm kill-server
  rm -f "$BATS_TEST_TMPDIR/started"
  run "$S" start demo --account default --account other
  [ "$status" -eq 0 ]
  started 1
  grep -q -- ' -- --account other$' "$BATS_TEST_TMPDIR/started"
  tm kill-server
  rm -f "$BATS_TEST_TMPDIR/started"
  run "$S" start demo "fix --account foo"
  [ "$status" -eq 0 ]
  started 1
  grep -q '^unset -- fix --account foo$' "$BATS_TEST_TMPDIR/started"
}

wake_record() { # wake_record <json account fragment>
  SID=11111111-2222-4333-8444-555555555555
  jq -n --arg p "$CCDASH_WS/demo" "{project: \$p} + $1" >"$CCDASH_STATE/$SID.json"
}

@test "wake resumes with the recorded account" {
  wake_record '{account: "work"}'
  run "$S" wake "$SID"
  [ "$status" -eq 0 ]
  started 1
  grep -q "^$CCDASH_ACCOUNTS_DIR/work --resume $SID" "$BATS_TEST_TMPDIR/started"
  [ "$(wins)" = "work " ]
  FAKE_CLAUDE_MCP=none run "$S" wake "$SID" # gate with the work dir: unregistered there
  [ "$status" -eq 7 ]
}

@test "wake of an old record without account is default, no CLAUDE_CONFIG_DIR" {
  wake_record '{}'
  run "$S" wake "$SID"
  [ "$status" -eq 0 ]
  started 1
  grep -q "^unset --resume $SID" "$BATS_TEST_TMPDIR/started"
  [ "$(wins)" = "default " ]
}

@test "wake with an invalid or unknown recorded account exits 1" {
  wake_record '{account: "../x"}'
  run "$S" wake "$SID"
  [ "$status" -eq 1 ]
  [[ $output == *"invalid"* ]]
  wake_record '{account: "ghost"}'
  run "$S" wake "$SID"
  [ "$status" -eq 1 ]
  ! tm has-session -t =claude-demo 2>/dev/null
}

@test "state.sh records the account from CLAUDE_CONFIG_DIR" {
  H=$ROOT/rootfs/usr/local/lib/ccdash/hooks/state.sh
  ev() { jq -nc --arg s "$1" '{session_id: $s, hook_event_name: "Stop", cwd: "/workspace/x", transcript_path: "/t"}'; }
  ev aaa | "$H" waiting
  [ "$(jq -r .account "$CCDASH_STATE/aaa.json")" = default ]
  ev bbb | CLAUDE_CONFIG_DIR=$CCDASH_ACCOUNTS_DIR/work "$H" waiting
  [ "$(jq -r .account "$CCDASH_STATE/bbb.json")" = work ]
  ev ccc | CLAUDE_CONFIG_DIR=/elsewhere/work "$H" waiting
  [ "$(jq -r .account "$CCDASH_STATE/ccc.json")" = default ]
  ev ddd | CLAUDE_CONFIG_DIR=$CCDASH_ACCOUNTS_DIR/a/b "$H" waiting
  [ "$(jq -r .account "$CCDASH_STATE/ddd.json")" = default ]
  ev eee | CLAUDE_CONFIG_DIR= "$H" waiting
  [ "$(jq -r .account "$CCDASH_STATE/eee.json")" = default ]
}

@test "attach takes only a project and an optional --account" {
  run "$S" attach demo extra
  [ "$status" -eq 2 ]
  run "$S" attach demo --account work extra
  [ "$status" -eq 2 ]
}

@test "an account dir that is a symlink is unknown" {
  ln -s "$CCDASH_ACCOUNTS_DIR/work" "$CCDASH_ACCOUNTS_DIR/lnk"
  run "$S" start demo --account lnk
  [ "$status" -eq 1 ]
  [[ $output == *"unknown account"* ]]
}

@test "start _login --account runs claude for that account in CCDASH_LOGIN_DIR, not a project" {
  export CCDASH_LOGIN_DIR=$BATS_TEST_TMPDIR/loginhome
  mkdir -p "$CCDASH_LOGIN_DIR"
  run "$S" start _login --account work
  [ "$status" -eq 0 ]
  [ "$output" = claude-_login ]
  [ "$(tm show-options -qv -t =claude-_login: @project_dir)" = "$CCDASH_LOGIN_DIR" ]
  [ "$(tm show-options -wqv -t =claude-_login: @account)" = work ]
  run "$S" start _login --account nope
  [ "$status" -eq 1 ]
}

@test "a default window added after an account session does not inherit its config dir" {
  "$S" start demo --account work
  started 1
  "$S" start demo
  started 2
  [ "$(sed -n 2p "$BATS_TEST_TMPDIR/started" | cut -d' ' -f1)" = unset ]
  [ "$(tm show-environment -t =claude-demo CLAUDE_CONFIG_DIR 2>&1 || true)" != "CLAUDE_CONFIG_DIR=$CCDASH_ACCOUNTS_DIR/work" ]
}
