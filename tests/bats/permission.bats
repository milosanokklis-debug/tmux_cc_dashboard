#!/usr/bin/env bats
# hooks/permission.sh: only a validated allow/deny from the broker becomes output; everything else is silence.
# curl is replaced by a stub that prints $STUB_BODY and exits with $STUB_RC.

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  HOOK=$ROOT/rootfs/usr/local/lib/ccdash/hooks/permission.sh
  export HOME=$BATS_TEST_TMPDIR/home
  mkdir -p "$HOME" "$BATS_TEST_TMPDIR/bin"
  unset TMUX
  export TMUX_PANE=%4 CCDASH_TMUX=$BATS_TEST_TMPDIR/none.sock
  cat >"$BATS_TEST_TMPDIR/bin/curl" <<'STUB'
#!/bin/bash
cat >"$STUB_POSTED"
printf '%s' "${STUB_BODY:-}"
exit "${STUB_RC:-0}"
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/curl"
  export STUB_POSTED=$BATS_TEST_TMPDIR/posted
  PATH=$BATS_TEST_TMPDIR/bin:$PATH
  IN='{"session_id":"s-1","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"/w"}'
}

hook() { printf '%s' "$IN" | "$HOOK"; }

@test "allow becomes the PermissionRequest decision, and the pane is posted" {
  STUB_BODY='{"behavior":"allow"}' run hook
  [ "$status" -eq 0 ]
  [ "$output" = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' ]
  [ "$(jq -r .pane "$STUB_POSTED")" = %4 ]
  [ "$(jq -r .tool_name "$STUB_POSTED")" = Bash ]
  [ "$(jq -r .state "$HOME/.ccdash/sessions/s-1.json")" = needs_approval ]
}

@test "deny keeps its message; allow drops one" {
  STUB_BODY='{"behavior":"deny","message":"use make"}' run hook
  [ "$(jq -r .hookSpecificOutput.decision.message <<<"$output")" = "use make" ]
  STUB_BODY='{"behavior":"allow","message":"x"}' run hook
  [ "$(jq -c .hookSpecificOutput.decision <<<"$output")" = '{"behavior":"allow"}' ]
}

@test "anything else is silent with exit 0" {
  for body in '' 'garbage' '{"behavior":"ask"}' '{"behavior":"allow","extra":1}' '{"behavior":"deny","message":5}' '["allow"]' '"allow"'; do
    STUB_BODY=$body run hook
    [ "$status" -eq 0 ]
    [ -z "$output" ]
  done
  STUB_BODY='{"behavior":"allow"}' STUB_RC=22 run hook
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "input that is not JSON posts nothing: silent, exit 0" {
  IN='not json' STUB_BODY='{"behavior":"allow"}' run hook
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -e "$STUB_POSTED" ]
}

@test "jq missing: drains stdin, exit 0, nothing printed or posted" {
  mkdir "$BATS_TEST_TMPDIR/nojq"
  for n in bash cat env; do ln -s "$(command -v $n)" "$BATS_TEST_TMPDIR/nojq/$n"; done
  nojq() { printf '%s' "$IN" | env PATH="$BATS_TEST_TMPDIR/nojq" "$HOOK"; }
  STUB_BODY='{"behavior":"allow"}' run nojq
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -e "$STUB_POSTED" ]
}
