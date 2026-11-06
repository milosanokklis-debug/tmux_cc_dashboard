#!/usr/bin/env bats
# Cue tests for tests/fake-claude/claude with a settings file whose hooks write marker lines.

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  export FAKE_CLAUDE_FIXTURES=$ROOT/tests/fixtures/2.1.317
  export FAKE_CLAUDE_TIMEOUT=3
  export FAKE_CLAUDE_SETTINGS=$BATS_TEST_TMPDIR/settings.json
  M=$BATS_TEST_TMPDIR/markers
  : >"$M"
  # marker hook: appends "<event> <source|tool_name>" to the marker file
  cat >"$BATS_TEST_TMPDIR/mark.sh" <<'EOS'
#!/usr/bin/env bash
jq -r '.hook_event_name + " " + (.source // .tool_name // "")' >>"$1"
EOS
  chmod +x "$BATS_TEST_TMPDIR/mark.sh"
  cat >"$BATS_TEST_TMPDIR/mark.sh-status" <<'EOS'
#!/usr/bin/env bash
jq -r '"\(.model.display_name) \(.rate_limits.five_hour.used_percentage)"'
EOS
  chmod +x "$BATS_TEST_TMPDIR/mark.sh-status"
  jq -n --arg c "$BATS_TEST_TMPDIR/mark.sh $M" '
    def h(e): {(e): [{hooks: [{type: "command", command: $c}]}]};
    {hooks: (h("SessionStart") + h("UserPromptSubmit") + h("PostToolUse") + h("Stop") + h("StopFailure")
      + h("SubagentStart") + h("SubagentStop") + h("SessionEnd") + h("Notification")),
     statusLine: {type: "command", command: ($c|sub(" .*";"") + "-status")}}' \
    >"$FAKE_CLAUDE_SETTINGS"
  export FAKE_CLAUDE_HOME=$BATS_TEST_TMPDIR/fh
  CLAUDE=$ROOT/tests/fake-claude/claude
}

perm_settings() { # $1 = stdout of the PermissionRequest hook
  jq -n --arg out "$1" '{hooks: {PermissionRequest: [{matcher: "Bash", hooks: [{type: "command", command: ("printf %s " + ($out|@sh))}]}]}}' >"$FAKE_CLAUDE_SETTINGS"
}

@test "plain prompt: start, prompt, stop, exit" {
  run "$CLAUDE" <<<"hello"
  [ "$status" -eq 0 ]
  [ "$(tr '\n' '|' <"$M")" = "SessionStart startup|UserPromptSubmit |Stop |SessionEnd |" ]
}

@test "resume flag sets source resume" {
  run "$CLAUDE" --resume <<<"/exit"
  [ "$status" -eq 0 ]
  grep -qx 'SessionStart resume' "$M"
  grep -qx 'SessionEnd ' "$M"
}

@test "/tool /sub /fail /notify fire their events" {
  run "$CLAUDE" <<<"go /tool /sub /notify idle /fail"
  [ "$status" -eq 0 ]
  grep -qx 'PostToolUse Bash' "$M"
  grep -qx 'SubagentStart ' "$M"
  grep -qx 'SubagentStop ' "$M"
  grep -qx 'Notification ' "$M"
  grep -qx 'StopFailure ' "$M"
  ! grep -qx 'Stop ' "$M"
}

@test "/esc prints interrupted, fires no Stop, and returns to the prompt" {
  run "$CLAUDE" <<<$'work /esc\nhello'
  [ "$status" -eq 0 ]
  [[ $output == *"interrupted"* ]]
  ! grep -qx 'Stop ' "$M"
  [ "$(grep -c '^UserPromptSubmit ' "$M")" -eq 2 ]
  [[ $output == *"done"* ]]
}

@test "/perm allow" {
  perm_settings '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
  run "$CLAUDE" <<<"x /perm allow"
  [[ $output == *"permission: allow"* ]]
}

@test "/perm deny" {
  perm_settings '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
  run "$CLAUDE" <<<"x /perm deny"
  [[ $output == *"permission: deny"* ]]
}

@test "/perm fall-through asks the user" {
  perm_settings ''
  run "$CLAUDE" <<<$'x /perm\ny'
  [[ $output == *"fall-through: asking user"* ]]
  [[ $output == *"permission: allow (user)"* ]]
}

@test "/status runs statusLine.command with the fixture" {
  run "$CLAUDE" <<<"/status"
  [ "$status" -eq 0 ]
  [[ $output == *"Opus 5.5 23.5"* ]]
}

@test "/status without statusLine prints fixture-derived text" {
  echo '{}' >"$FAKE_CLAUDE_SETTINGS"
  run "$CLAUDE" <<<"/status"
  [[ $output == *"5h 23.5% | 7d 41.2%"* ]]
}

@test "EOF runs SessionEnd and exits 0" {
  run "$CLAUDE" </dev/null
  [ "$status" -eq 0 ]
  grep -qx 'SessionEnd ' "$M"
}

@test "a hanging hook is cut off by FAKE_CLAUDE_TIMEOUT" {
  jq -n '{hooks: {Stop: [{hooks: [{type: "command", command: "sleep 30"}]}]}}' >"$FAKE_CLAUDE_SETTINGS"
  FAKE_CLAUDE_TIMEOUT=1 run "$CLAUDE" <<<"hi"
  [ "$status" -eq 0 ]
  [[ $output == *"exited 124"* ]]
}

@test "a bracketed paste is one prompt, multi-line text kept exactly, recorded in prompts/" {
  text=$'it\'s "q" $(touch /nonexistent/x) `id`; a && b \\ \xc3\xa9\n\n  indented\nthe word Enter'
  run "$CLAUDE" <<<"$(printf '\033[200~%s\033[201~' "$text")"$'\n/exit'
  [ "$status" -eq 0 ]
  f=$(ls "$FAKE_CLAUDE_HOME"/prompts/*.1)
  [ "$(cat "$f"; printf x)" = "${text}x" ]
  [ "$(grep -c '^UserPromptSubmit ' "$M")" -eq 1 ]
  [ "$(wc -l <"$FAKE_CLAUDE_HOME"/history/*)" -eq 1 ] # history keeps one line per prompt
  [ ! -e "$FAKE_CLAUDE_HOME"/prompts/*.2 ]
}

@test "a paste containing a cue word runs the cue" {
  run "$CLAUDE" <<<$'\033[200~first\n/tool\033[201~'
  grep -qx 'PostToolUse Bash' "$M"
}

@test "/long blocks until Esc, then prints interrupted, notifies idle and fires no Stop" {
  output=$(printf 'go /long\n\033[200~/exit\033[201~\n\033' | "$CLAUDE")
  [[ $output == *"working..."* ]]
  [[ $output == *"interrupted"* ]]
  grep -qx interrupted "$FAKE_CLAUDE_HOME/events.log"
  grep -qx 'Notification ' "$M"
  ! grep -qx 'Stop ' "$M"
  [ "$(grep -c '^SessionEnd' "$M")" -eq 1 ] # only at EOF: the pasted /exit did not end the turn
}

@test "/perm uses the hook timeout and reports the deny message" {
  jq -n '{hooks: {PermissionRequest: [{matcher: "Bash", hooks: [{type: "command", timeout: 4,
    command: "sleep 2; printf %s \"{\\\"hookSpecificOutput\\\":{\\\"decision\\\":{\\\"behavior\\\":\\\"deny\\\",\\\"message\\\":\\\"use rg instead\\\"}}}\""}]}]}}' >"$FAKE_CLAUDE_SETTINGS"
  FAKE_CLAUDE_TIMEOUT=1 run "$CLAUDE" <<<"x /perm"
  [[ $output == *"permission: deny"* ]]
  [[ $output == *"permission-message: use rg instead"* ]]
  grep -qx 'permission deny' "$FAKE_CLAUDE_HOME/events.log"
  grep -qx 'permission-message: use rg instead' "$FAKE_CLAUDE_HOME/events.log"
}

@test "FAKE_CLAUDE_RATE_LIMITS drops or sets rate_limits in the /status payload" {
  FAKE_CLAUDE_RATE_LIMITS=none run "$CLAUDE" <<<"/status"
  [[ $output == *"Opus 5.5 null"* ]]
  FAKE_CLAUDE_RATE_LIMITS="61 12" run "$CLAUDE" <<<"/status"
  [[ $output == *"Opus 5.5 61"* ]]
}

@test "FAKE_CLAUDE_TRANSCRIPTS: a transcript per prompt (duplicate assistant lines) and a subagent transcript" {
  export FAKE_CLAUDE_TRANSCRIPTS=$BATS_TEST_TMPDIR/projects FAKE_CLAUDE_USAGE="1 2 3 4"
  : >"$M"
  cd "$BATS_TEST_TMPDIR"
  run "$CLAUDE" <<<$'hello\nrun /sub'
  [ "$status" -eq 0 ]
  main=$(ls "$FAKE_CLAUDE_TRANSCRIPTS"/*/*.jsonl)
  [ "$(jq -s '[.[] | select(.type == "user")] | length' "$main")" = 2 ]
  [ "$(jq -s '[.[] | select(.type == "assistant")] | length' "$main")" = 4 ]
  [ "$(jq -s '[.[] | .message.id // empty] | unique | length' "$main")" = 2 ]
  [ "$(jq -sr '[.[] | select(.type == "assistant")][0].message.usage | "\(.input_tokens) \(.output_tokens) \(.cache_creation_input_tokens) \(.cache_read_input_tokens)"' "$main")" = "1 2 3 4" ]
  sub=$(ls "$FAKE_CLAUDE_TRANSCRIPTS"/*/*/subagents/agent-*.jsonl)
  [ "$(jq -s 'length' "$sub")" = 3 ]
  aid=$(sed 's/.*agent-\(.*\)\.jsonl/\1/' <<<"$sub")
  grep -q "subagent $aid" "$FAKE_CLAUDE_HOME/events.log"
}

@test "FAKE_CLAUDE_TRANSCRIPTS: hook payloads carry the transcript and subagent paths" {
  export FAKE_CLAUDE_TRANSCRIPTS=$BATS_TEST_TMPDIR/projects
  cat >"$BATS_TEST_TMPDIR/dump.sh" <<'EOS'
#!/usr/bin/env bash
jq -c '{e: .hook_event_name, t: .transcript_path, a: .agent_id, p: .agent_transcript_path}' >>"$1"
EOS
  chmod +x "$BATS_TEST_TMPDIR/dump.sh"
  jq -n --arg c "$BATS_TEST_TMPDIR/dump.sh $M" '{hooks: {SubagentStop: [{hooks: [{type: "command", command: $c}]}]}}' >"$FAKE_CLAUDE_SETTINGS"
  : >"$M"
  cd "$BATS_TEST_TMPDIR"
  run "$CLAUDE" <<<"go /sub"
  [ "$status" -eq 0 ]
  [ "$(jq -r .t "$M")" = "$(ls "$FAKE_CLAUDE_TRANSCRIPTS"/*/*.jsonl)" ]
  [ "$(jq -r .p "$M")" = "$(ls "$FAKE_CLAUDE_TRANSCRIPTS"/*/*/subagents/agent-*.jsonl)" ]
  [[ $(jq -r .a "$M") =~ ^a[0-9a-f]{16}$ ]]
}
