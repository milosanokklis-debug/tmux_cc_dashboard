#!/usr/bin/env bats
# Kit re-check on opted-in projects: before a new conversation (ccd-session start) and `ccd-session kit-recheck`.
# Stubs log $0 and CLAUDE_CONFIG_DIR, then exec the agent-kit stub. Local bare repo (insteadOf), no network.

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  BIN=$ROOT/rootfs/usr/local/bin
  export HOME=$BATS_TEST_TMPDIR/home
  export CCDASH_WS=$BATS_TEST_TMPDIR/ws CCDASH_PROJECTS=$HOME/.ccdash/projects
  export CCDASH_TMUX=$BATS_TEST_TMPDIR/tmux.sock CCDASH_STATE=$HOME/.ccdash/sessions
  export CCDASH_KIT_HOME=$BATS_TEST_TMPDIR/kithome CCDASH_LOCK_DIR=$BATS_TEST_TMPDIR/locks
  export CCDASH_KIT_LIB=$ROOT/rootfs/usr/local/lib/ccdash CCDASH_ACCOUNTS_LIB=$ROOT/rootfs/usr/local/lib/ccdash
  export CCDASH_ACCOUNTS_DIR=$BATS_TEST_TMPDIR/accounts KIT_REPO=octo/kit CCDASH_KIT_LOCK_WAIT=20
  export FAKE_CLAUDE_HOME=$BATS_TEST_TMPDIR/fake FAKE_CLAUDE_SETTINGS=/nonexistent FAKE_CLAUDE_MCP=connected CCDASH_MCP_TIMEOUT=5
  export RUNLOG=$BATS_TEST_TMPDIR/runs.log STUB_LOG=$BATS_TEST_TMPDIR/stub.log
  export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
  unset STUB_EXIT STUB_VERSION STUB_MEMORY STUB_SECRET CCDASH_KIT CCDASH_KIT_TIMEOUT TMUX TMUX_PANE CLAUDE_CONFIG_DIR
  mkdir -p "$HOME/bin" "$CCDASH_WS" "$CCDASH_STATE" "$CCDASH_PROJECTS" "$CCDASH_ACCOUNTS_DIR/work" "$CCDASH_ACCOUNTS_DIR/alt"
  git config --global init.defaultBranch main
  git config --global protocol.file.allow always
  printf '#!/bin/bash\nif [ "${1:-}" = mcp ]; then exec %q "$@"; fi\nsleep 30\n' "$ROOT/tests/fake-claude/claude" > "$HOME/bin/claude"
  chmod +x "$HOME/bin/claude"
  export PATH=$HOME/bin:$PATH
  printf 'export PATH=%s/bin:$PATH\n' "$HOME" > "$HOME/.bash_profile"
  # stub kit: log the script path and the config dir, then behave like the agent-kit stub
  printf '#!/bin/bash\necho "$0 ${CLAUDE_CONFIG_DIR:-unset}" >> %q\nexec %q "$@"\n' "$RUNLOG" "$ROOT/tests/fixtures/agent-kit-stub.sh" > "$BATS_TEST_TMPDIR/kitstub"
  chmod +x "$BATS_TEST_TMPDIR/kitstub"
  export CCDASH_KIT=$BATS_TEST_TMPDIR/kitstub
  S=$BIN/ccd-session
}

teardown() { tmux -S "$CCDASH_TMUX" kill-server 2> /dev/null || true; chmod -R u+w "$BATS_TEST_TMPDIR" 2> /dev/null || true; }

# mkproj <name> <record-json>: bare origin, checkout in the workspace, project record
mkproj() {
  local b=$BATS_TEST_TMPDIR/$1.git w=$BATS_TEST_TMPDIR/$1.w
  git init -q --bare "$b"; git --git-dir="$b" symbolic-ref HEAD refs/heads/main
  git clone -q "$b" "$w" 2> /dev/null; echo x > "$w/f"; git -C "$w" add f; git -C "$w" commit -qm one; git -C "$w" push -q origin HEAD:main
  git config --global url."$b".insteadOf "https://github.com/octo/$1.git"
  git clone -q "$b" "$CCDASH_WS/$1" 2> /dev/null
  git -C "$CCDASH_WS/$1" remote set-url origin "https://github.com/octo/$1.git"
  printf '%s\n' "$2" > "$CCDASH_PROJECTS/$1.json"
}
rec() { jq -r "$1" "$CCDASH_PROJECTS/$2.json"; }
ON='{"repo":"octo/demo","kitEnabled":true}'

@test "start runs ensure for an opted-in project with the account's config dir" {
  mkproj demo "$ON"
  run "$S" start demo --account work
  [ "$status" -eq 0 ] && [ "$output" = claude-demo ]
  grep -q "^$CCDASH_KIT $CCDASH_ACCOUNTS_DIR/work\$" "$RUNLOG"
  [ "$(rec .kitCheck.account demo)" = work ]
  [[ $(rec .kitCheck.status demo) =~ ^(ok|changed)$ ]]
}

@test "a kit-off project runs nothing; start prints only the session name" {
  mkproj demo '{"repo":"octo/demo","kitEnabled":false}'
  run "$S" start demo
  [ "$status" -eq 0 ] && [ "$output" = claude-demo ]
  [ ! -e "$RUNLOG" ]
  [ "$(rec '.kitCheck // "none"' demo)" = none ]
  run "$S" kit-recheck
  [ "$status" -eq 0 ] && [ -z "$output" ] && [ ! -e "$RUNLOG" ]
}

@test "the active kit in CCDASH_KIT_HOME/current is what runs" {
  unset CCDASH_KIT
  mkdir -p "$CCDASH_KIT_HOME/current"
  printf '#!/bin/bash\necho "$0" >> %q\nexec %q "$@"\n' "$RUNLOG" "$ROOT/tests/fixtures/agent-kit-stub.sh" > "$CCDASH_KIT_HOME/current/agent-kit.sh"
  chmod +x "$CCDASH_KIT_HOME/current/agent-kit.sh"
  mkproj demo "$ON"
  run "$S" start demo
  [ "$status" -eq 0 ] && [ "$output" = claude-demo ]
  [ "$(head -n1 "$RUNLOG")" = "$CCDASH_KIT_HOME/current/agent-kit.sh" ]
}

@test "a failing kit still starts the session and records kitError and kitCheck failed" {
  mkproj demo "$ON"
  STUB_EXIT=4 run "$S" start demo
  [ "$status" -eq 0 ] && [ "$output" = claude-demo ]
  [ "$(rec .kitCheck.status demo)" = failed ]
  [ "$(rec .kitError.code demo)" != null ]
  tmux -S "$CCDASH_TMUX" has-session -t =claude-demo
}

@test "a hanging kit times out, the session still starts, timeout is recorded" {
  mkproj demo "$ON"
  printf '#!/bin/bash\nsleep 30\n' > "$BATS_TEST_TMPDIR/kitstub"
  CCDASH_KIT_TIMEOUT=2 run "$S" start demo
  [ "$status" -eq 0 ] && [ "$output" = claude-demo ]
  [ "$(rec .kitCheck.status demo)" = failed ]
  [ "$(rec .kitError.message demo)" = "timed out after 2s" ]
  [ "$(rec .kitError.code demo)" = 124 ]
}

@test "kit-recheck runs for default and every account, opted-in projects only" {
  mkproj demo "$ON"
  mkproj other '{"repo":"octo/other"}'
  run "$S" kit-recheck
  [ "$status" -eq 0 ] && [ -z "$output" ]
  [ "$(wc -l < "$RUNLOG")" -eq 3 ]
  grep -q " unset\$" "$RUNLOG"
  grep -q " $CCDASH_ACCOUNTS_DIR/work\$" "$RUNLOG"
  grep -q " $CCDASH_ACCOUNTS_DIR/alt\$" "$RUNLOG"
  [ "$(rec '.kitCheck // "none"' other)" = none ]
}

@test "success clears an old kitError and records kitCheck ok" {
  mkproj demo '{"repo":"octo/demo","kitEnabled":true,"kitError":{"code":4,"message":"old"}}'
  run "$S" kit-recheck
  [ "$status" -eq 0 ]
  [ "$(rec '.kitError // "none"' demo)" = none ]
  [[ $(rec .kitCheck.status demo) =~ ^(ok|changed)$ ]]
  [ "$(rec .kitCheck.ts demo)" != null ]
}

@test "a dirty checkout does not stop the re-check (no pull); the user's change stays" {
  mkproj demo "$ON"
  echo dirty >> "$CCDASH_WS/demo/f"
  run "$S" start demo
  [ "$status" -eq 0 ] && [ "$output" = claude-demo ]
  [[ $(rec .kitCheck.status demo) =~ ^(ok|changed)$ ]]
  [ "$(git -C "$CCDASH_WS/demo" status --porcelain -- f)" = " M f" ]
}

@test "a project lock held elsewhere: session starts within the timeout, kitCheck mentions busy" {
  mkproj demo "$ON"
  mkdir -p "$CCDASH_LOCK_DIR"
  flock "$CCDASH_LOCK_DIR/kit-demo.lock" sleep 15 &
  local bg=$!
  sleep 0.5
  SECONDS=0
  CCDASH_KIT_TIMEOUT=6 run "$S" start demo
  kill "$bg" 2> /dev/null || true
  [ "$status" -eq 0 ] && [ "$output" = claude-demo ]
  [ "$SECONDS" -le 10 ]
  [ "$(rec .kitCheck.status demo)" = failed ]
  [[ $(rec .kitCheck.message demo) == *[Bb]usy* ]]
  [ "$(rec .kitError.code demo)" = 5 ]
}

@test "re-check does not pull: HEAD stays put although origin has a new commit" {
  mkproj demo "$ON"
  w=$BATS_TEST_TMPDIR/demo.w
  before=$(git -C "$CCDASH_WS/demo" rev-parse HEAD)
  git -C "$CCDASH_WS/demo" fetch -q origin # origin/main = before; a later fetch or pull would move it
  [ "$(git -C "$CCDASH_WS/demo" rev-parse origin/main)" = "$before" ]
  echo y > "$w/g"; git -C "$w" add g; git -C "$w" commit -qm two; git -C "$w" push -q origin HEAD:main
  run "$S" kit-recheck
  [ "$status" -eq 0 ]
  [ "$(git -C "$CCDASH_WS/demo" rev-parse origin/main)" = "$before" ] # no fetch
  [ "$(git -C "$CCDASH_WS/demo" rev-parse HEAD~0)" != "" ] && ! git -C "$CCDASH_WS/demo" merge-base --is-ancestor "$(git -C "$w" rev-parse HEAD)" HEAD # the kit commit may move HEAD, never to the remote commit
  [ ! -e "$CCDASH_WS/demo/g" ]
  ! git -C "$CCDASH_WS/demo" log --format=%s | grep -qx two
  [[ $(rec .kitCheck.status demo) =~ ^(ok|changed)$ ]]
}

@test "a kit killed by the timeout leaves the checkout as it was, dirty file included, and records kitError" {
  mkproj demo "$ON"
  d=$CCDASH_WS/demo
  echo mine > "$d/notes.txt"; echo more >> "$d/f"
  before=$(git -C "$d" status --porcelain)
  printf '#!/bin/bash\nmkdir -p "$2/.claude"; echo kit > "$2/.claude/CLAUDE.md"; echo kit > "$2/.claude/settings.json"; echo kit > "$2/CLAUDE.md"\nsleep 30\n' > "$BATS_TEST_TMPDIR/slowkit"
  chmod +x "$BATS_TEST_TMPDIR/slowkit"
  export CCDASH_KIT=$BATS_TEST_TMPDIR/slowkit CCDASH_KIT_TIMEOUT=2
  run "$S" kit-recheck
  [ "$status" -eq 0 ]
  [ "$(git -C "$d" status --porcelain)" = "$before" ]
  [ ! -e "$d/.claude" ]
  [ "$(rec .kitError.code demo)" = 124 ]
  ! pgrep -f "$BATS_TEST_TMPDIR/slowkit" > /dev/null
}

@test "the kit commit holds only kit paths; the user's own staged file stays staged" {
  mkproj demo "$ON"
  d=$CCDASH_WS/demo
  echo mine > "$d/mine.txt"; git -C "$d" add mine.txt
  run "$S" start demo --account work
  [ "$status" -eq 0 ]
  [ "$(rec .kitCheck.status demo)" = changed ]
  [ "$(git -C "$d" log -1 --format=%s)" != one ]
  ! git -C "$d" show --name-only --format= HEAD | grep -qx mine.txt
  git -C "$d" show --name-only --format= HEAD | grep -q CLAUDE.md
  [ "$(git -C "$d" diff --cached --name-only)" = mine.txt ]
}
