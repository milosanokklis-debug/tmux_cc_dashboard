#!/usr/bin/env bats
# Basic Memory: the ccd-session start gate, the managed-settings allow rule, ccd-memory-init idempotency.
# Uses the fake claude (`mcp list` / `mcp add`, FAKE_CLAUDE_MCP) and a private tmux socket.

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  BIN=$ROOT/rootfs/usr/local/bin
  export HOME=$BATS_TEST_TMPDIR/home
  export CCDASH_WS=$BATS_TEST_TMPDIR/ws
  export CCDASH_TMUX=$BATS_TEST_TMPDIR/tmux.sock
  export CCDASH_STATE=$HOME/.ccdash/sessions
  export FAKE_CLAUDE_HOME=$BATS_TEST_TMPDIR/fake
  export FAKE_CLAUDE_SETTINGS=$ROOT/rootfs/etc/claude-code/managed-settings.json
  export FAKE_CLAUDE_FIXTURES=$ROOT/tests/fixtures/2.1.317
  export FAKE_CLAUDE_MCP=connected
  export CCDASH_MCP_TIMEOUT=5
  mkdir -p "$HOME/bin" "$CCDASH_WS/demo" "$CCDASH_STATE"
  ln -s "$ROOT/tests/fake-claude/claude" "$HOME/bin/claude"
  export PATH=$HOME/bin:$PATH
  printf 'export PATH=%s/bin:$PATH\n' "$HOME" >"$HOME/.bash_profile" # bash -l resets PATH
  unset TMUX TMUX_PANE
}

teardown() { tmux -S "$CCDASH_TMUX" kill-server 2>/dev/null || true; }

sleeping_conversation() { # a state record that wake accepts
  SID=11111111-2222-4333-8444-555555555555
  jq -n --arg p "$CCDASH_WS/demo" '{project: $p}' >"$CCDASH_STATE/$SID.json"
}

@test "start passes the gate when basic-memory is connected" {
  run "$BIN/ccd-session" start demo
  [ "$status" -eq 0 ]
  [ "$output" = claude-demo ]
}

@test "start refuses with exit 7 and 'memory offline' for disconnected, failed and none" {
  for v in disconnected failed none; do
    FAKE_CLAUDE_MCP=$v run "$BIN/ccd-session" start demo
    [ "$status" -eq 7 ] || { echo "$v: status $status"; false; }
    [[ ${lines[0]} == "memory offline" ]]
  done
  ! tmux -S "$CCDASH_TMUX" has-session -t =claude-demo 2>/dev/null
}

@test "the refusal carries the claude mcp list output" {
  FAKE_CLAUDE_MCP=failed run "$BIN/ccd-session" start demo
  [ "$status" -eq 7 ]
  [[ $output == *"Failed to connect"* ]]
}

@test "wake passes when connected and is refused (7) otherwise" {
  sleeping_conversation
  FAKE_CLAUDE_MCP=disconnected run "$BIN/ccd-session" wake "$SID"
  [ "$status" -eq 7 ]
  [[ ${lines[0]} == "memory offline" ]]
  FAKE_CLAUDE_MCP=failed run "$BIN/ccd-session" wake "$SID"
  [ "$status" -eq 7 ]
  FAKE_CLAUDE_MCP=none run "$BIN/ccd-session" wake "$SID"
  [ "$status" -eq 7 ]
  run "$BIN/ccd-session" wake "$SID"
  [ "$status" -eq 0 ]
  [ "$output" = claude-demo ]
}

@test "only the basic-memory line counts" {
  # another server connected must not satisfy the gate
  rm -f "$HOME/bin/claude"
  cat >"$HOME/bin/claude" <<'EOS'
#!/bin/bash
[ "$1 $2" = "mcp list" ] && printf 'other: x - \xe2\x9c\x93 Connected\nbasic-memory: y - \xe2\x9c\x97 Failed to connect\n'
EOS
  chmod +x "$HOME/bin/claude"
  run "$BIN/ccd-session" start demo
  [ "$status" -eq 7 ]
}

@test "managed settings: server-wide allow rule mcp__basic-memory, deny kept" {
  f=$ROOT/rootfs/etc/claude-code/managed-settings.json
  run jq -e '.permissions.allow | index("mcp__basic-memory")' "$f"
  [ "$status" -eq 0 ]
  run jq -e '.permissions.allow | map(select(startswith("mcp__basic-memory"))) == ["mcp__basic-memory"]' "$f"
  [ "$status" -eq 0 ]
  run jq -e '.permissions.deny | index("Bash(tmux:*)")' "$f"
  [ "$status" -eq 0 ]
}

@test "ccd-memory-init registers once and is a no-op the second time" {
  fakebm=$HOME/fake-bm
  cat >"$fakebm" <<'EOS'
#!/bin/bash
echo "$*" >>"$FAKE_BM_LOG"
case "$1 $2" in
  "project list") echo '{"projects":[{"name":"main","is_default":true}]}' ;;
esac
EOS
  chmod +x "$fakebm"
  export FAKE_BM_LOG=$BATS_TEST_TMPDIR/bm.log CCDASH_BM=$fakebm CCDASH_MEMORY_HOME=$HOME
  FAKE_CLAUDE_MCP=none run "$BIN/ccd-memory-init"
  [ "$status" -eq 0 ]
  [ "$(wc -l <"$FAKE_CLAUDE_HOME/mcp-add.log")" -eq 1 ]
  grep -q -- 'add --scope user basic-memory -e' "$FAKE_CLAUDE_HOME/mcp-add.log"
  grep -q -- ' -- .* mcp$' "$FAKE_CLAUDE_HOME/mcp-add.log"
  grep -q -- "BASIC_MEMORY_HOME=$HOME/basic-memory" "$FAKE_CLAUDE_HOME/mcp-add.log"
  FAKE_CLAUDE_MCP=none run "$BIN/ccd-memory-init"
  [ "$status" -eq 0 ]
  [ "$(wc -l <"$FAKE_CLAUDE_HOME/mcp-add.log")" -eq 1 ]
  ! grep -q 'project add\|project default' "$FAKE_BM_LOG"
}

@test "ccd-memory-init creates project main when missing and never fails the boot" {
  fakebm=$HOME/fake-bm
  printf '#!/bin/bash\necho "$*" >>"$FAKE_BM_LOG"\n[ "$1 $2" = "project list" ] && echo "{\\"projects\\":[]}"\nexit 0\n' >"$fakebm"
  chmod +x "$fakebm"
  export FAKE_BM_LOG=$BATS_TEST_TMPDIR/bm.log CCDASH_BM=$fakebm CCDASH_MEMORY_HOME=$HOME
  run "$BIN/ccd-memory-init"
  [ "$status" -eq 0 ]
  grep -q "project add main $HOME/basic-memory --default" "$FAKE_BM_LOG"
  CCDASH_BM=/nonexistent FAKE_CLAUDE_MCP=none run "$BIN/ccd-memory-init"
  [ "$status" -eq 0 ]
}
