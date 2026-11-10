#!/usr/bin/env bats
# hooks/state.sh: a record written by an older version (a path in `project`, an `account` key) is normalised.

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  STATE=$ROOT/rootfs/usr/local/lib/ccdash/hooks/state.sh
  export HOME=$BATS_TEST_TMPDIR/home CCDASH_WS=/workspace
  mkdir -p "$HOME/.ccdash/sessions"
  unset TMUX TMUX_PANE CCDASH_RESUMED_FROM
  D=$HOME/.ccdash/sessions
  SID=11111111-2222-4333-8444-555555555555
}

ev() { jq -nc --arg sid "$SID" '{session_id: $sid, hook_event_name: "Stop", cwd: "/workspace/demo", transcript_path: "/t.jsonl"}'; }

@test "a path under the workspace in project becomes the project name" {
  echo '{"sid":"x","project":"/workspace/demo/sub","state":"working"}' >"$D/$SID.json"
  CLAUDE_PROJECT_DIR=/workspace/demo run "$STATE" waiting < <(ev)
  [ "$(jq -r .project "$D/$SID.json")" = demo ]
}

@test "the account key is dropped" {
  echo '{"sid":"x","project":"demo","account":"old","state":"working"}' >"$D/$SID.json"
  CLAUDE_PROJECT_DIR=/workspace/demo run "$STATE" waiting < <(ev)
  [ "$(jq -r 'has("account")' "$D/$SID.json")" = false ]
  [ "$(jq -r .project "$D/$SID.json")" = demo ]
}

@test "a project name already in the record is kept" {
  echo '{"sid":"x","project":"kept","state":"working"}' >"$D/$SID.json"
  CLAUDE_PROJECT_DIR=/workspace/demo run "$STATE" waiting < <(ev)
  [ "$(jq -r .project "$D/$SID.json")" = kept ]
}
