#!/usr/bin/env bats
# ccd-kit status|check|update. Local bare repos (insteadOf), no network. The fake kit repo holds
# tests/fixtures/agent-kit-stub.sh plus a KIT_VERSION line, so `ensure` works through ccd-onboard.

setup() {
  ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
  BIN=$ROOT/rootfs/usr/local/bin
  export HOME=$BATS_TEST_TMPDIR/home
  export CCDASH_WS=$BATS_TEST_TMPDIR/ws CCDASH_PROJECTS=$HOME/.ccdash/projects
  export CCDASH_KIT_HOME=$BATS_TEST_TMPDIR/kithome CCDASH_LOCK_DIR=$BATS_TEST_TMPDIR/locks
  export CCDASH_KIT_IMAGE=$BATS_TEST_TMPDIR/image KIT_REPO=octo/kit
  export STUB_LOG=$BATS_TEST_TMPDIR/stub.log CCDASH_KIT_LOCK_WAIT=20
  unset STUB_EXIT STUB_VERSION STUB_MEMORY STUB_SECRET CCDASH_KIT
  export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
  mkdir -p "$HOME" "$CCDASH_WS"
  git config --global init.defaultBranch main
  git config --global protocol.file.allow always
  # image kit
  mkdir -p "$CCDASH_KIT_IMAGE"; git init -q "$CCDASH_KIT_IMAGE"
  { cat "$ROOT/tests/fixtures/agent-kit-stub.sh"; echo 'KIT_VERSION="0.0.1"'; } > "$CCDASH_KIT_IMAGE/agent-kit.sh"
  chmod +x "$CCDASH_KIT_IMAGE/agent-kit.sh"
  git -C "$CCDASH_KIT_IMAGE" add -A; git -C "$CCDASH_KIT_IMAGE" commit -qm image
  IMG=$(git -C "$CCDASH_KIT_IMAGE" rev-parse HEAD)
  # upstream kit repo
  KBARE=$BATS_TEST_TMPDIR/kit.git; KW=$BATS_TEST_TMPDIR/kitw
  git init -q --bare "$KBARE"; git --git-dir="$KBARE" symbolic-ref HEAD refs/heads/main
  git clone -q "$KBARE" "$KW" 2> /dev/null
  git config --global url."$KBARE".insteadOf https://github.com/octo/kit
  kit_commit 1.2.3
}

teardown() { chmod -R u+w "$BATS_TEST_TMPDIR" 2> /dev/null || true; }

# kit_commit <version>: new tip of main with that KIT_VERSION
kit_commit() {
  { cat "$ROOT/tests/fixtures/agent-kit-stub.sh"; echo "KIT_VERSION=\"$1\""; } > "$KW/agent-kit.sh"
  chmod +x "$KW/agent-kit.sh"
  git -C "$KW" add -A; git -C "$KW" commit -qm "v$1"; git -C "$KW" push -q origin HEAD:main
  TIP=$(git -C "$KW" rev-parse HEAD)
}

mkproj() { # name
  local b=$BATS_TEST_TMPDIR/$1.git w=$BATS_TEST_TMPDIR/$1.w
  git init -q --bare "$b"; git --git-dir="$b" symbolic-ref HEAD refs/heads/main
  git clone -q "$b" "$w" 2> /dev/null; echo x > "$w/f"; git -C "$w" add f; git -C "$w" commit -qm one; git -C "$w" push -q origin HEAD:main
  git config --global url."$b".insteadOf "https://github.com/octo/$1.git"
}

notemp() { [ -z "$(ls -A "$CCDASH_KIT_HOME" | grep '^\.tmp' || true)" ]; }

@test "status: no current -> active is the image; version read as text" {
  run "$BIN/ccd-kit" status
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "active $IMG 0.0.1" ]
  [ "${lines[1]}" = "image $IMG" ]
}

@test "check: active, image, newest" {
  run "$BIN/ccd-kit" check
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "active $IMG 0.0.1" ]
  [ "${lines[1]}" = "image $IMG" ]
  [ "${lines[2]}" = "newest $TIP" ]
}

@test "check: unreachable upstream prints newest-error and exits 1" {
  KIT_REPO=octo/nothere run "$BIN/ccd-kit" check
  [ "$status" -eq 1 ]
  [ "${lines[0]}" = "active $IMG 0.0.1" ]
  [[ ${lines[2]} == "newest-error "* ]]
}

@test "update: fetches newest, flips current, read-only checkout" {
  run "$BIN/ccd-kit" update
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "updated $IMG $TIP" ]
  [ "${lines[1]}" = "version 0.0.1 1.2.3" ]
  [ "$(readlink "$CCDASH_KIT_HOME/current")" = "$TIP" ]
  [ -f "$CCDASH_KIT_HOME/$TIP/agent-kit.sh" ]
  [ ! -w "$CCDASH_KIT_HOME/$TIP/agent-kit.sh" ]
  run "$BIN/ccd-kit" status
  [ "${lines[0]}" = "active $TIP 1.2.3" ]
  notemp
}

@test "update: only the new and the previous checkout are kept after 3 updates; same sha is a no-op success" {
  "$BIN/ccd-kit" update; a=$TIP
  kit_commit 1.2.4; b=$TIP; run "$BIN/ccd-kit" update; [ "${lines[0]}" = "updated $a $b" ]
  kit_commit 1.2.5; c=$TIP; run "$BIN/ccd-kit" update; [ "${lines[0]}" = "updated $b $c" ]
  [ "$(find "$CCDASH_KIT_HOME" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 2 ]
  [ -d "$CCDASH_KIT_HOME/$b" ] && [ -d "$CCDASH_KIT_HOME/$c" ] && [ ! -e "$CCDASH_KIT_HOME/$a" ]
  run "$BIN/ccd-kit" update
  [ "$status" -eq 0 ]; [ "${lines[0]}" = "updated $c $c" ]
}

@test "update <ref>: an older sha can be pinned" {
  first=$TIP; kit_commit 1.2.4
  run "$BIN/ccd-kit" update "${first:0:12}"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "updated $IMG $first" ]
  [ "${lines[1]}" = "version 0.0.1 1.2.3" ]
}

@test "update --reset: current is gone, active is the image again" {
  "$BIN/ccd-kit" update
  run "$BIN/ccd-kit" update --reset
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "updated $TIP $IMG" ]
  [ "${lines[1]}" = "version 1.2.3 0.0.1" ]
  [ ! -e "$CCDASH_KIT_HOME/current" ]
  run "$BIN/ccd-kit" status
  [ "${lines[0]}" = "active $IMG 0.0.1" ]
}

@test "failed fetch leaves current unchanged and no temp dirs" {
  "$BIN/ccd-kit" update
  KIT_REPO=octo/nothere run "$BIN/ccd-kit" update
  [ "$status" -eq 1 ]
  [ "$(readlink "$CCDASH_KIT_HOME/current")" = "$TIP" ]
  notemp
  run "$BIN/ccd-kit" update nosuchbranch
  [ "$status" -eq 1 ]
  [ "$(readlink "$CCDASH_KIT_HOME/current")" = "$TIP" ]
}

@test "a checkout without agent-kit.sh or without KIT_VERSION is refused" {
  "$BIN/ccd-kit" update; good=$TIP
  git -C "$KW" checkout -q -b nover; echo 'echo hi' > "$KW/agent-kit.sh"; git -C "$KW" commit -qam nover; git -C "$KW" push -q origin nover
  git -C "$KW" checkout -q -b nokit main; git -C "$KW" rm -q agent-kit.sh; git -C "$KW" commit -qm nokit; git -C "$KW" push -q origin nokit
  for r in nover nokit; do
    run "$BIN/ccd-kit" update "$r"
    [ "$status" -eq 1 ]
    [ "$(readlink "$CCDASH_KIT_HOME/current")" = "$good" ]
  done
  [ "$(find "$CCDASH_KIT_HOME" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1 ]
  notemp
}

@test "bad refs are rejected before any network, nothing changes" {
  export KIT_REPO=octo/nothere
  for r in ';rm' '-x' 'a..b' 'a//b' 'a/' 'x.lock' '$(id)'; do
    run "$BIN/ccd-kit" update "$r"
    [ "$status" -eq 2 ]
  done
  [ ! -e "$CCDASH_KIT_HOME" ]
  run "$BIN/ccd-kit" update one two
  [ "$status" -eq 2 ]
}

@test "update re-checks only opted-in projects (on, off, legacy .kit only)" {
  mkproj on; mkproj off; mkproj legacy
  CCDASH_KIT=$ROOT/tests/fixtures/agent-kit-stub.sh "$BIN/ccd-onboard" --kit octo/on > /dev/null
  CCDASH_KIT=$ROOT/tests/fixtures/agent-kit-stub.sh "$BIN/ccd-onboard" --kit octo/legacy > /dev/null
  CCDASH_KIT=$ROOT/tests/fixtures/agent-kit-stub.sh "$BIN/ccd-onboard" octo/off > /dev/null
  jq 'del(.kitEnabled)' "$CCDASH_PROJECTS/legacy.json" > "$BATS_TEST_TMPDIR/l" && mv "$BATS_TEST_TMPDIR/l" "$CCDASH_PROJECTS/legacy.json"
  jq -e '.kitEnabled == false' "$CCDASH_PROJECTS/off.json"
  : > "$STUB_LOG"
  run "$BIN/ccd-kit" update
  [ "$status" -eq 0 ]
  printf '%s\n' "${lines[@]}" | grep -q '^project on '
  printf '%s\n' "${lines[@]}" | grep -q '^project legacy '
  ! printf '%s\n' "${lines[@]}" | grep -q '^project off '
  [ "$(grep -c 'args=ensure' "$STUB_LOG")" -eq 2 ]
  run "$BIN/ccd-kit" update --reset
  [[ ${lines[0]} == "project "* ]]
  [[ ${lines[-2]} == "updated "* && ${lines[-1]} == "version "* ]]
}

@test "a failing project is reported, update still exits 0" {
  mkproj on
  CCDASH_KIT=$ROOT/tests/fixtures/agent-kit-stub.sh "$BIN/ccd-onboard" --kit octo/on > /dev/null
  STUB_EXIT=4 run "$BIN/ccd-kit" update
  [ "$status" -eq 0 ]
  [[ $output == *"project on failed kit-error 4 "* ]]
  [ "$(readlink "$CCDASH_KIT_HOME/current")" = "$TIP" ]
}

@test "a second update waits for the lock" {
  mkdir -p "$CCDASH_LOCK_DIR"
  ( exec 7> "$CCDASH_LOCK_DIR/kit.lock"; flock 7; sleep 4 ) &
  holder=$!
  sleep 0.5
  "$BIN/ccd-kit" update > "$BATS_TEST_TMPDIR/out" 2>&1 &
  upd=$!
  sleep 1.5
  kill -0 "$upd"
  [ ! -e "$CCDASH_KIT_HOME/current" ]
  wait "$holder"
  wait "$upd"
  [ "$(readlink "$CCDASH_KIT_HOME/current")" = "$TIP" ]
}

@test "lock wait timeout exits 1 with a message" {
  mkdir -p "$CCDASH_LOCK_DIR"
  ( exec 7> "$CCDASH_LOCK_DIR/kit.lock"; flock 7; sleep 4 ) &
  sleep 0.5
  CCDASH_KIT_LOCK_WAIT=1 run "$BIN/ccd-kit" update
  [ "$status" -eq 1 ]
  [[ $output == *"another kit"* ]]
  wait
}

@test "kit_version is strict" {
  . "$ROOT/rootfs/usr/local/lib/ccdash/kit.sh"
  printf 'x\nKIT_VERSION="1.2.3"\n' > "$BATS_TEST_TMPDIR/a"; [ "$(kit_version "$BATS_TEST_TMPDIR/a")" = 1.2.3 ]
  printf 'KIT_VERSION="1.2 3"\n' > "$BATS_TEST_TMPDIR/b"; ! kit_version "$BATS_TEST_TMPDIR/b"
  printf ' KIT_VERSION="1.2.3"\n' > "$BATS_TEST_TMPDIR/c"; ! kit_version "$BATS_TEST_TMPDIR/c"
  ! kit_version "$BATS_TEST_TMPDIR/none"
}
