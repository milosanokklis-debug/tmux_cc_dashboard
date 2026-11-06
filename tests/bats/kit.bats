#!/usr/bin/env bats
# Agent-kit step of ccd-onboard, the rebase in ccd-project pull and the hook-gate exemption.
# Local bare repos (insteadOf), no network; the kit is tests/fixtures/agent-kit-stub.sh (same `ensure` contract
# as the real kit). The real kit is only touched by the last test, which skips when it or `claude` is absent.

setup() {
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
}

push_commit() { git -C "$W" pull -q origin main 2>/dev/null; echo "$1" > "$W/f"; git -C "$W" commit -qam "$1"; git -C "$W" push -q origin HEAD:main; }
# everything that matters about a checkout: HEAD, status (ignored files too), and every file's hash
state() {
  git -C "$D" rev-parse HEAD
  git -C "$D" status --porcelain --ignored
  (cd "$D" && find . -path ./.git -prune -o -type f -print | sort | xargs sha256sum)
}
subjects() { git -C "$D" log --format=%s; }

@test "fresh onboard: one chore commit by ccdash with only .claude/ and CLAUDE.md; record has kit and packs" {
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"kit 0.9.2 changed"* ]]
  [[ $output == *"packs kit-core"* ]]
  [[ $output == *"memory connected"* ]]
  [ "${lines[-1]}" = "head $(git -C "$D" rev-parse HEAD)" ]
  [ "$(git -C "$D" rev-list --count HEAD)" -eq 2 ]
  [ "$(git -C "$D" log -1 --format='%an <%ae>|%cn <%ce>|%s')" = 'ccdash <ccdash@localhost>|ccdash <ccdash@localhost>|chore: agent-kit 0.9.2' ]
  [ "$(git -C "$D" diff-tree --no-commit-id --name-only -r HEAD | paste -sd' ')" = ".claude/agent-kit.json .claude/settings.json CLAUDE.md" ]
  [ -z "$(git -C "$D" status --porcelain)" ]
  [ "$(git --git-dir="$BARE" rev-parse main)" = "$(git -C "$W" rev-parse HEAD)" ] # never pushed
  [ "$(jq -c .kit "$REC")" = '{"version":"0.9.2","packs":["kit-core"],"memory":"connected"}' ]
  [ "$(jq -c .packs "$REC")" = '["kit-core"]' ]
  [ "$(jq -r .head "$REC")" = "$(git -C "$D" rev-parse HEAD)" ]
  [ "$(jq -r 'has("kitError")' "$REC")" = false ]
  grep -q "args=ensure $D --json NO_COLOR=1 TMPDIR=/tmp KIT_REPO=octo/kit" "$STUB_LOG"
  [ -s "$HOME/.ccdash/kit-demo.log" ]
}

@test "second onboard: nothing changes, no commit, tree clean" {
  "$BIN/ccd-onboard" octo/demo
  before=$(state)
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"kit 0.9.2 unchanged"* ]]
  [ "$(state)" = "$before" ]
  [ "$(git -C "$D" rev-list --count HEAD)" -eq 2 ]
}

@test "memory missing and a different version are recorded" {
  STUB_MEMORY=missing STUB_VERSION=1.2.3 run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"memory missing"* ]]
  [ "$(git -C "$D" log -1 --format=%s)" = "chore: agent-kit 1.2.3" ]
  [ "$(jq -c .kit "$REC")" = '{"version":"1.2.3","packs":["kit-core"],"memory":"missing"}' ]
}

@test "design and code packs: flags, record, reuse without flags, and unticking removes kit-design and the skill" {
  "$BIN/ccd-onboard" octo/demo
  run "$BIN/ccd-onboard" --design --code octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"packs kit-core,kit-design,kit-code"* ]]
  grep -q "args=ensure $D design code --json" "$STUB_LOG"
  [ "$(jq -c .packs "$REC")" = '["kit-core","kit-design","kit-code"]' ]
  [ "$(jq -r '.enabledPlugins | keys | join(",")' "$D/.claude/settings.json")" = "kit-code@agent-kit,kit-core@agent-kit,kit-design@agent-kit" ]
  [ -f "$D/.claude/skills/web-design-guidelines/SKILL.md" ]
  [ -z "$(git -C "$D" status --porcelain)" ] # the vendored skill ignores itself
  [ "$(git -C "$D" rev-list --count HEAD)" -eq 3 ]
  # no flags: the packs of the last onboarding are reused, nothing changes
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"kit 0.9.2 unchanged"* ]]
  [[ $output == *"packs kit-core,kit-design,kit-code"* ]]
  [ "$(git -C "$D" rev-list --count HEAD)" -eq 3 ]
  # untick design
  run "$BIN/ccd-onboard" --no-design octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *"packs kit-core,kit-code"* ]]
  grep -q "args=ensure $D code --json" "$STUB_LOG"
  run grep -q kit-design "$D/.claude/settings.json"
  [ "$status" -eq 1 ]
  run grep -q kit-design "$D/.claude/agent-kit.json"
  [ "$status" -eq 1 ]
  [ ! -e "$D/.claude/skills/web-design-guidelines" ]
  [ "$(git -C "$D" rev-list --count HEAD)" -eq 4 ]
  [ "$(git -C "$D" log -1 --format='%ae|%s')" = 'ccdash@localhost|chore: agent-kit 0.9.2' ]
  [ -z "$(git -C "$D" status --porcelain)" ]
  [ "$(jq -c .packs "$REC")" = '["kit-core","kit-code"]' ]
  run "$BIN/ccd-onboard" --no-code octo/demo
  [ "$(jq -c .packs "$REC")" = '["kit-core"]' ]
}

@test "kit exit 2..6: message printed, exit 8, repo exactly as it was, no commit, record only gets kitError" {
  declare -A msg=([2]="Kit usage error" [3]="Kit prerequisite missing" [4]="Kit marketplace failed (network?)" [5]="Plugin install or update failed" [6]="Could not write project files")
  "$BIN/ccd-onboard" octo/demo
  before=$(state)
  for n in 2 3 4 5 6; do
    STUB_EXIT=$n run "$BIN/ccd-onboard" --design octo/demo
    [ "$status" -eq 8 ]
    [[ $output == *"kit-error $n ${msg[$n]}"* ]]
    [[ $output == *"stub: scribbling"* ]] # the log tail follows
    [ "$(state)" = "$before" ]
    [ "$(jq -r .kitError.code "$REC")" = "$n" ]
    [ "$(jq -c .kit "$REC")" = '{"version":"0.9.2","packs":["kit-core"],"memory":"connected"}' ] # last good kit state kept
  done
  [[ $(STUB_EXIT=4 "$BIN/ccd-onboard" octo/demo) == *"retry"* ]]
  [[ $(STUB_EXIT=5 "$BIN/ccd-onboard" octo/demo) == *"retry"* ]]
  run "$BIN/ccd-onboard" octo/demo # recovers, and clears the error
  [ "$status" -eq 0 ]
  [ "$(jq -r 'has("kitError")' "$REC")" = false ]
}

@test "kit failure on a fresh clone keeps the clone untouched past the clone" {
  STUB_EXIT=4 run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 8 ]
  [ "$(git -C "$D" rev-parse HEAD)" = "$(git -C "$W" rev-parse HEAD)" ]
  [ -z "$(git -C "$D" status --porcelain --ignored)" ]
  [ ! -e "$D/.claude" ]
  [ ! -e "$D/CLAUDE.md" ]
  [ "$(jq -r .kitError.code "$REC")" = 4 ]
  [ "$(jq -r 'has("kit")' "$REC")" = false ]
}

@test "kit failure restores user files the kit had modified, and leaves other untracked-ignored files alone" {
  mkdir -p "$W/.claude"
  echo '{"permissions":{"allow":["Read"]}}' > "$W/.claude/settings.json"
  printf '# mine\n' > "$W/CLAUDE.md"
  printf '.claude/settings.local.json\n' > "$W/.gitignore"
  git -C "$W" add -A; git -C "$W" commit -qm project; git -C "$W" push -q origin HEAD:main
  STUB_EXIT=3 run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 8 ]
  echo keepme > "$D/.claude/settings.local.json"
  before=$(state)
  STUB_EXIT=6 run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 8 ]
  [ "$(state)" = "$before" ]
  [ "$(cat "$D/CLAUDE.md")" = "# mine" ]
  [ "$(cat "$D/.claude/settings.local.json")" = keepme ]
}

@test "pull after the remote gains a commit rebases the kit commit on top" {
  "$BIN/ccd-onboard" octo/demo
  old_kit=$(git -C "$D" rev-parse HEAD)
  push_commit two
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 0 ]
  [[ $output == *rebased* ]]
  new_kit=$(git -C "$D" rev-parse HEAD)
  [ "$new_kit" != "$old_kit" ]
  [ "$(git -C "$D" rev-parse HEAD~1)" = "$(git -C "$W" rev-parse HEAD)" ]
  [ "$(git -C "$D" log -1 --format='%ae|%s')" = 'ccdash@localhost|chore: agent-kit 0.9.2' ]
  [ "$(cat "$D/f")" = two ]
  [ -z "$(git -C "$D" status --porcelain)" ]
  [ "$(git -C "$D" rev-list --count HEAD)" -eq 3 ]
  [ "$(jq -r .head "$REC")" = "$new_kit" ]
}

@test "pull refuses to rebase a hand-made local commit (other author), HEAD unchanged" {
  "$BIN/ccd-onboard" octo/demo
  echo mine > "$D/g"; git -C "$D" add g; git -C "$D" commit -qm mine
  push_commit two
  before=$(state)
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 3 ]
  [[ $output == *"local commits not from ccdash"* ]]
  [ "$(state)" = "$before" ]
}

@test "pull refuses a ccdash-authored local commit that touches other paths" {
  "$BIN/ccd-onboard" octo/demo
  echo mine > "$D/g"; git -C "$D" add g
  GIT_AUTHOR_EMAIL=ccdash@localhost git -C "$D" commit -qm sneaky
  push_commit two
  before=$(state)
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 3 ]
  [[ $output == *"local commits not from ccdash"* ]]
  [ "$(state)" = "$before" ]
}

@test "a rebase conflict is aborted: 'rebase failed', exit 3, repo as before" {
  "$BIN/ccd-onboard" octo/demo
  git -C "$W" pull -q origin main
  echo remote > "$W/CLAUDE.md"; git -C "$W" add CLAUDE.md; git -C "$W" commit -qm claude; git -C "$W" push -q origin HEAD:main
  before=$(state)
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 3 ]
  [[ $output == *"rebase failed"* ]]
  [ "$(state)" = "$before" ]
  [ ! -e "$D/.git/rebase-merge" ]
  [ ! -e "$D/.git/rebase-apply" ]
}

@test "diverged with only non-kit local work keeps the Phase D message" {
  "$BIN/ccd-onboard" octo/demo
  push_commit two
  echo l > "$D/g"; git -C "$D" add g; git -C "$D" commit -qm local
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 3 ]
  [[ $output == *"demo has diverged from origin"* ]]
}

# ---- hook gate ----------------------------------------------------------------------------------------------
add_settings() { # add_settings <file> <json>
  git -C "$W" pull -q origin main 2>/dev/null
  mkdir -p "$W/.claude"; rm -f "$W/.claude/$1"; printf '%s\n' "$2" > "$W/.claude/$1"
  git -C "$W" add .claude; git -C "$W" commit -qm "settings $1"; git -C "$W" push -q origin HEAD:main
}
KITSET='{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}}},"enabledPlugins":{"kit-core@agent-kit":true}}'

@test "a repo with its own hooks is still refused (exit 5) and the kit never runs" {
  add_settings settings.json '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"evil"}]}]}}'
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 5 ]
  [[ $output == *"hooks: Stop"* ]]
  [ ! -e "$D" ]
  [ ! -e "$STUB_LOG" ]
}

@test "the kit's own committed settings do not trip the gate: pull and fresh clone" {
  "$BIN/ccd-onboard" octo/demo
  git -C "$D" push -q origin HEAD:main # a user pushes the kit commit
  push_commit two
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 0 ]
  [ "$(git -C "$D" rev-parse HEAD)" = "$(git -C "$W" rev-parse HEAD)" ]
  rm -rf "$D" "$CCDASH_PROJECTS"
  run "$BIN/ccd-onboard" octo/demo # fresh clone of a repo that already carries the kit
  [ "$status" -eq 0 ]
  [ "$(git -C "$D" rev-list --count HEAD)" -eq "$(git -C "$W" rev-list --count HEAD)" ] # unchanged, no new commit
}

@test "enabledPlugins/extraKnownMarketplaces are still refused without agent-kit.json, with a foreign repo, extra fields or next to hooks" {
  export CCDASH_KIT= # gate only: no kit commit of our own to conflict with
  "$BIN/ccd-onboard" octo/demo
  before=$(git -C "$D" rev-parse HEAD)
  add_settings settings.json "$KITSET" # no agent-kit.json
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  [[ $output == *"hooks: enabledPlugins,extraKnownMarketplaces"* ]]
  [ "$(git -C "$D" rev-parse HEAD)" = "$before" ]
  add_settings agent-kit.json '{"kit_version":"1"}'
  run "$BIN/ccd-project" pull demo # now exempt
  [ "$status" -eq 0 ]
  git -C "$D" reset -q --hard "$before"
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"evil/market"}}},"enabledPlugins":{"kit-core@agent-kit":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  [[ $output == *"hooks: enabledPlugins,extraKnownMarketplaces"* ]]
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"},"x":1}},"enabledPlugins":{"kit-core@agent-kit":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}}},"enabledPlugins":{"kit-core@other":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}}},"enabledPlugins":{"kit-core@agent-kit":true},"hooks":{"Stop":[]},"env":{"A":"b"}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  [[ $output == *Stop* ]]
  [[ $output == *env* ]]
  [[ $output != *enabledPlugins* ]] # the kit keys themselves are not what is flagged
  [ "$(git -C "$D" rev-parse HEAD)" = "$before" ]
}

@test "a plugin the kit does not write is refused even under an allowlisted marketplace; the exact upstream ones pass" {
  export CCDASH_KIT=
  "$BIN/ccd-onboard" octo/demo
  before=$(git -C "$D" rev-parse HEAD)
  add_settings agent-kit.json '{"kit_version":"1"}'
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}}},"enabledPlugins":{"evil@agent-kit":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  [[ $output == *enabledPlugins* ]]
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}},"hallmark":{"source":{"source":"github","repo":"Nutlope/hallmark"}}},"enabledPlugins":{"kit-core@agent-kit":true,"hallmark@hallmark":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 0 ]
  git -C "$D" reset -q --hard "$before"
  add_settings settings.json '{"extraKnownMarketplaces":{"agent-kit":{"source":{"source":"github","repo":"octo/kit"}},"hallmark":{"source":{"source":"github","repo":"Nutlope/hallmark"}}},"enabledPlugins":{"kit-core@agent-kit":true,"other@hallmark":true}}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
}

@test "agent-kit.json must be a regular file holding an object with kit_version" {
  export CCDASH_KIT=
  "$BIN/ccd-onboard" octo/demo
  before=$(git -C "$D" rev-parse HEAD)
  add_settings settings.json "$KITSET"
  git -C "$W" pull -q origin main 2>/dev/null
  ln -s settings.json "$W/.claude/agent-kit.json" # a symlink, even to valid JSON
  git -C "$W" add .claude; git -C "$W" commit -qm link; git -C "$W" push -q origin HEAD:main
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  git -C "$D" reset -q --hard "$before"
  add_settings agent-kit.json '[1]'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  git -C "$D" reset -q --hard "$before"
  add_settings agent-kit.json '{"kit_version":1}'
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
  [ "$(git -C "$D" rev-parse HEAD)" = "$before" ]
}

@test "a symlinked .claude: kit step refused with 'Could not write project files', exit 8, nothing changed" {
  mkdir -p "$W/elsewhere"; echo '{}' > "$W/elsewhere/settings.json"; ln -s elsewhere "$W/.claude"
  git -C "$W" add .; git -C "$W" commit -qm link; git -C "$W" push -q origin HEAD:main
  run "$BIN/ccd-onboard" --trust-hooks octo/demo
  [ "$status" -eq 8 ]
  [[ $output == *"kit-error 6 Could not write project files"* ]]
  [ -L "$D/.claude" ]
  [ "$(cat "$D/elsewhere/settings.json")" = '{}' ]
  [ ! -e "$D/elsewhere/agent-kit.json" ]
  [ -z "$(git -C "$D" status --porcelain)" ]
  [ ! -e "$STUB_LOG" ]
}

@test "the kit log shown on failure is a redacted tail, and the log file is owner-only" {
  STUB_SECRET=hunter2hunter2 STUB_EXIT=5 run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 8 ]
  [[ $output == *"token=***"* ]]
  [[ $output == *"Bearer ***"* ]]
  [[ $output != *hunter2* ]]
  [ "$(stat -c %a "$HOME/.ccdash/kit-demo.log")" = 600 ]
}

@test "pull refuses to rebase over a local merge commit" {
  "$BIN/ccd-onboard" octo/demo
  git -C "$D" checkout -q -b side
  echo s > "$D/.claude/side"; git -C "$D" add .claude
  GIT_AUTHOR_EMAIL=ccdash@localhost git -C "$D" commit -qm side
  git -C "$D" checkout -q main
  git -C "$D" merge -q --no-ff side -m "local merge"
  push_commit two
  before=$(state)
  run "$BIN/ccd-onboard" octo/demo
  [ "$status" -eq 3 ]
  [[ $output == *"local commits not from ccdash"* ]]
  [ "$(state)" = "$before" ]
}

@test "settings.local.json is never exempt" {
  export CCDASH_KIT=
  "$BIN/ccd-onboard" octo/demo
  add_settings agent-kit.json '{"kit_version":"1"}'
  add_settings settings.local.json "$KITSET"
  run "$BIN/ccd-project" pull demo
  [ "$status" -eq 5 ]
}

# ---- the real kit (skipped on the CI runner: no /opt/agent-kit, no claude) -------------------------------------
@test "real kit: ensure on a folder that is not a git root fails with exit 2 and the JSON failure line" {
  [ -x /opt/agent-kit/agent-kit.sh ] || skip "no /opt/agent-kit"
  command -v claude > /dev/null || skip "no claude"
  mkdir "$BATS_TEST_TMPDIR/nogit"
  run /opt/agent-kit/agent-kit.sh ensure "$BATS_TEST_TMPDIR/nogit" --json
  [ "$status" -eq 2 ]
  [ "$(printf '%s\n' "$output" | tail -n 1 | jq -r '[.ok, .code] | join(",")')" = "false,2" ]
}
