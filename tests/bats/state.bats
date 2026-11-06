#!/usr/bin/env bats
# hooks/state.sh: the per-conversation state file, and "never fails Claude" (also without jq).

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  STATE=$ROOT/rootfs/usr/local/lib/ccdash/hooks/state.sh
  export HOME=$BATS_TEST_TMPDIR/home
  mkdir -p "$HOME"
  unset TMUX TMUX_PANE CCDASH_RESUMED_FROM
  export CCDASH_TMUX=$BATS_TEST_TMPDIR/none.sock
  D=$HOME/.ccdash/sessions
  SID=11111111-2222-4333-8444-555555555555
}

ev() { jq -nc --arg sid "${2:-$SID}" --arg e "$1" '{session_id: $sid, hook_event_name: $e, cwd: "/workspace/cwd", transcript_path: "/t.jsonl"}'; }
field() { jq -r ".$1" "$D/$SID.json"; }

@test "writes the record with the expected fields, group-readable, no temp file left" {
  export TMUX_PANE=%4 CLAUDE_PROJECT_DIR=/workspace/demo
  run "$STATE" waiting < <(ev SessionStart)
  [ "$status" -eq 0 ]
  [ "$(field state)" = waiting ]
  [ "$(field event)" = SessionStart ]
  [ "$(field project)" = /workspace/demo ]
  [ "$(field pane)" = %4 ]
  [ "$(field transcript)" = /t.jsonl ]
  [ "$(field waiting_since)" != null ]
  [ "$(stat -c %a "$D/$SID.json")" = 640 ]
  [ "$(ls -A "$D")" = "$SID.json" ]
}

@test "project is written once; pane survives events without TMUX_PANE; waiting_since is kept while waiting" {
  export TMUX_PANE=%4 CLAUDE_PROJECT_DIR=/workspace/demo
  "$STATE" waiting < <(ev SessionStart)
  since=$(field waiting_since)
  sleep 1
  unset TMUX_PANE
  CLAUDE_PROJECT_DIR=/workspace/other "$STATE" waiting < <(ev Stop)
  [ "$(field project)" = /workspace/demo ]
  [ "$(field pane)" = %4 ]
  [ "$(field waiting_since)" = "$since" ]
  "$STATE" working < <(ev UserPromptSubmit)
  [ "$(field state)" = working ]
  [ "$(field waiting_since)" = null ]
}

@test "project falls back to cwd; resumed_from comes from CCDASH_RESUMED_FROM" {
  CCDASH_RESUMED_FROM=aaaa "$STATE" waiting < <(ev SessionStart)
  [ "$(field project)" = /workspace/cwd ]
  [ "$(field resumed_from)" = aaaa ]
}

@test "a corrupt previous record is replaced; a bad or missing session id writes nothing" {
  mkdir -p "$D"
  echo '{not json' >"$D/$SID.json"
  run "$STATE" waiting < <(ev Stop)
  [ "$status" -eq 0 ]
  [ "$(field state)" = waiting ]
  rm "$D/$SID.json"
  for bad in '../../x' 'a b' 'a/b'; do
    run "$STATE" waiting < <(ev Stop "$bad")
    [ "$status" -eq 0 ]
  done
  run "$STATE" waiting <<<'{"hook_event_name":"Stop"}'
  [ "$status" -eq 0 ]
  run "$STATE" waiting <<<'not json at all'
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$D")" ]
}

@test "with jq removed: exit 0, no output, nothing written" {
  mkdir -p "$BATS_TEST_TMPDIR/nojq"
  for c in bash cat mkdir date mktemp rm chmod mv; do ln -s "$(command -v $c)" "$BATS_TEST_TMPDIR/nojq/$c"; done
  PATH=$BATS_TEST_TMPDIR/nojq run "$STATE" waiting < <(ev Stop)
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$(ls -A "$D")" ]
}

@test "with jq removed Claude still runs: the fake claude reports no hook error" {
  mkdir -p "$BATS_TEST_TMPDIR/nojq"
  for c in bash cat mkdir date mktemp rm chmod mv; do ln -s "$(command -v $c)" "$BATS_TEST_TMPDIR/nojq/$c"; done
  # same hooks as production, but the hook commands run with a PATH that has no jq
  jq --arg p "$BATS_TEST_TMPDIR/nojq" --arg root "$ROOT/rootfs/usr/local/lib/ccdash" '
    walk(if type == "string" and startswith("/usr/local/lib/ccdash/") then "PATH=\($p) " + ($root + ltrimstr("/usr/local/lib/ccdash")) else . end)' \
    "$ROOT/rootfs/etc/claude-code/managed-settings.json" >"$BATS_TEST_TMPDIR/settings.json"
  export FAKE_CLAUDE_SETTINGS=$BATS_TEST_TMPDIR/settings.json FAKE_CLAUDE_FIXTURES=$ROOT/tests/fixtures/2.1.317
  export FAKE_CLAUDE_HOME=$BATS_TEST_TMPDIR/fake
  run "$ROOT/tests/fake-claude/claude" <<<$'hello /tool\n/exit'
  [ "$status" -eq 0 ]
  [[ $output != *"hook for"* ]]
  [ -z "$(ls -A "$D" 2>/dev/null)" ]
  [ ! -s "$HOME/.ccdash/hook.log" ]
}

@test "the same run with jq present records the conversation (control for the test above)" {
  jq --arg root "$ROOT/rootfs/usr/local/lib/ccdash" '
    walk(if type == "string" and startswith("/usr/local/lib/ccdash/") then $root + ltrimstr("/usr/local/lib/ccdash") else . end)' \
    "$ROOT/rootfs/etc/claude-code/managed-settings.json" >"$BATS_TEST_TMPDIR/settings.json"
  export FAKE_CLAUDE_SETTINGS=$BATS_TEST_TMPDIR/settings.json FAKE_CLAUDE_FIXTURES=$ROOT/tests/fixtures/2.1.317
  export FAKE_CLAUDE_HOME=$BATS_TEST_TMPDIR/fake
  run "$ROOT/tests/fake-claude/claude" <<<$'hello\n/exit'
  [ "$status" -eq 0 ]
  [ "$(jq -r .state "$D"/*.json)" = ended ]
}

@test "records the tmux server pid and start time next to the pane" {
  command -v tmux >/dev/null || skip "tmux not installed"
  export CCDASH_TMUX=$BATS_TEST_TMPDIR/t.sock
  tmux -S "$CCDASH_TMUX" new-session -d -s x 'sleep 30'
  pane=$(tmux -S "$CCDASH_TMUX" list-panes -a -F '#{pane_id}')
  TMUX=x,1,0 TMUX_PANE=$pane "$STATE" waiting < <(ev SessionStart)
  want=$(tmux -S "$CCDASH_TMUX" display -p '#{pid} #{start_time}')
  tmux -S "$CCDASH_TMUX" kill-server
  [ "$(field pane)" = "$pane" ]
  [ "$(field tmux_pid) $(field tmux_start)" = "$want" ]
}

@test "a 200 KB PostToolUse payload is still recorded (the payload does not travel as an argument)" {
  { printf '{"session_id":"%s","hook_event_name":"PostToolUse","cwd":"/workspace/cwd","transcript_path":"/t.jsonl","tool_response":{"output":"' "$SID"
    head -c 200000 /dev/zero | tr '\0' x
    printf '"}}'; } >"$BATS_TEST_TMPDIR/big.json"
  [ "$(wc -c <"$BATS_TEST_TMPDIR/big.json")" -gt 200000 ]
  run "$STATE" working <"$BATS_TEST_TMPDIR/big.json"
  [ "$status" -eq 0 ]
  [ "$(field state)" = working ]
  [ "$(field event)" = PostToolUse ]
}

@test "CCDASH_HIDDEN=1 (the /usage helper Claude) records no state and no agent event" {
  CCDASH_HIDDEN=1 run "$STATE" waiting < <(ev SessionStart)
  [ "$status" -eq 0 ]
  CCDASH_HIDDEN=1 run "$ROOT/rootfs/usr/local/lib/ccdash/hooks/agents.sh" session < <(ev SessionStart)
  [ "$status" -eq 0 ]
  [ ! -e "$HOME/.ccdash/sessions" ] && [ ! -e "$HOME/.ccdash/agents" ] || [ -z "$(ls -A "$HOME/.ccdash/sessions" "$HOME/.ccdash/agents" 2>/dev/null)" ]
}
