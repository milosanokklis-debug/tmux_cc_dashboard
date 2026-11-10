#!/usr/bin/env bats
# ccd-onboard drives agent-kit 0.14.0 `attach`/`detach` (no-trace mode) instead of `ensure` + a chore commit.
# Local bare repos, no network; the kit is tests/fixtures/agent-kit-stub.sh (attach/detach imitate 0.14.0).

setup() {
  export CCDASH_MEMORY_INIT=/bin/true
  export CCDASH_CONFIG_ROOT=$BATS_TEST_TMPDIR/projects
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  BIN=$ROOT/rootfs/usr/local/bin
  export HOME=$BATS_TEST_TMPDIR/home
  export CCDASH_WS=$BATS_TEST_TMPDIR/ws
  export CCDASH_PROJECTS=$BATS_TEST_TMPDIR/home/.ccdash/projects
  export CCDASH_KIT=$ROOT/tests/fixtures/agent-kit-stub.sh KIT_REPO=octo/kit
  export STUB_LOG=$BATS_TEST_TMPDIR/stub.log
  unset STUB_EXIT STUB_VERSION STUB_MEMORY STUB_SECRET
  export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
  mkdir -p "$HOME" "$CCDASH_WS"
  git config --global init.defaultBranch main
  git config --global protocol.file.allow always
  BARE=$BATS_TEST_TMPDIR/demo.git
  git init -q --bare "$BARE"
  W=$BATS_TEST_TMPDIR/seed
  git clone -q "$BARE" "$W" 2>/dev/null
  echo one > "$W/f"; git -C "$W" add f; git -C "$W" commit -qm one; git -C "$W" push -q origin HEAD:main
  git --git-dir="$BARE" symbolic-ref HEAD refs/heads/main
  git config --global url."$BARE".insteadOf https://github.com/octo/demo.git
  D=$CCDASH_WS/demo
  REC=$CCDASH_PROJECTS/demo.json
  EX=$D/.git/info/exclude
}

@test "AC-2.1 --kit on a fresh checkout runs attach, no commit, clean status, exclude block written" {
  run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 0 ]
  grep -q "^args=attach $D NO_COLOR=" "$STUB_LOG"
  ! grep -q "args=ensure" "$STUB_LOG"
  ! grep -q -- "--no-" "$STUB_LOG"
  [ "$(git -C "$D" rev-list --count HEAD)" -eq 1 ]
  [ "$(git -C "$D" log -1 --format=%s)" = one ]
  [ -z "$(git -C "$D" status --porcelain)" ]
  grep -q '^# agent-kit:private start$' "$EX"
  grep -q '^# agent-kit:private end$' "$EX"
  [ -f "$D/.claude/agent-kit.json" ]
}

@test "AC-2.2 --no-kit on an attached project runs detach, block gone, kitEnabled false" {
  "$BIN/ccd-onboard" --kit octo/demo
  : > "$STUB_LOG"
  run "$BIN/ccd-onboard" --no-kit octo/demo
  [ "$status" -eq 0 ]
  grep -q "^args=detach $D NO_COLOR=" "$STUB_LOG"
  ! grep -q "args=ensure" "$STUB_LOG"
  ! grep -q '# agent-kit:private' "$EX"
  [ "$(jq -r .kitEnabled "$REC")" = false ]
}

@test "AC-2.3 kit off runs neither attach nor detach and leaves the exclude file alone" {
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 0 ]
  [ ! -s "$STUB_LOG" ]
  before=$(cat "$EX")
  run "$BIN/ccd-onboard" octo/demo # still off
  [ ! -s "$STUB_LOG" ]
  [ "$(cat "$EX")" = "$before" ]
  ! grep -q 'agent-kit:private' "$EX"
}

@test "AC-2.4 attach failing: exit 8, kit-error line, checkout, exclude and git config as before" {
  "$BIN/ccd-onboard" octo/demo # kit off: plain clone
  exbefore=$(cat "$EX"); cfgbefore=$(cat "$D/.git/config"); head=$(git -C "$D" rev-parse HEAD)
  STUB_EXIT=4 run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 8 ]
  grep -q "^args=attach $D NO_COLOR=" "$STUB_LOG"
  [[ $output == *"kit-error 4 "* ]]
  [ "$(git -C "$D" rev-parse HEAD)" = "$head" ]
  [ -z "$(git -C "$D" status --porcelain)" ]
  [ "$(cat "$EX")" = "$exbefore" ]
  [ "$(cat "$D/.git/config")" = "$cfgbefore" ]
  [ ! -e "$D/.claude/agent-kit.json" ]
}

@test "AC-2.5 pull on an attached project: hook gate does not refuse, kit 0.14.0 unchanged" {
  export STUB_VERSION=0.14.0
  "$BIN/ccd-onboard" --kit octo/demo
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"kit 0.14.0 unchanged"* ]]
  [ "$(grep -c '^args=attach ' "$STUB_LOG")" -eq 2 ]
  ! grep -q "args=ensure" "$STUB_LOG"
  [ -z "$(git -C "$D" status --porcelain)" ]
}

@test "AC-2.6 a repo tracking .claude/agents/orchestrator.md keeps it tracked and unchanged; kit's warning lands in the record" {
  mkdir -p "$W/.claude/agents"; echo mine > "$W/.claude/agents/orchestrator.md"
  git -C "$W" add .claude; git -C "$W" commit -qm agent; git -C "$W" push -q origin HEAD:main
  run "$BIN/ccd-onboard" --kit octo/demo
  [ "$status" -eq 0 ]
  [ -n "$(git -C "$D" ls-files .claude/agents/orchestrator.md)" ]
  [ "$(cat "$D/.claude/agents/orchestrator.md")" = mine ]
  [ -z "$(git -C "$D" status --porcelain)" ]
  ! grep -q 'agents/orchestrator.md' "$EX"
  jq -c . "$REC" | grep -q 'orchestrator.md'
}
