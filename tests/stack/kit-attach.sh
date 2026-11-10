#!/usr/bin/env bash
# Kit 0.14 attach on a test compose stack, with the REAL agent kit and the real claude CLI of the base image (not the
# stack image with the fake claude and the inert kit): a local bare repo stands in for GitHub (git url.<bare>.insteadOf),
# the kit's plugin marketplaces come from github.com (needs network). AC-4.1: a project onboarded with --kit leaves the
# tree clean (nothing untracked, no tracked kit path), has the `# agent-kit:private` block in .git/info/exclude and the
# kit-core, kit-design and kit-code plugins installed. AC-4.2: the kit-on project does not push (the kit pre-push hook
# needs a Claude login); instead what a push would send (HEAD tree and the commits ahead of the fetched remote main)
# holds no kit path, and a force-added kit path is refused by the pre-commit leak guard. AC-4.3: a project onboarded
# with --no-kit really pushes .claude/agents/x.md and AGENTS.md to its bare remote and has no exclude block. AC-4.4: after a container restart (no -v) the start re-check records
# kitCheck status ok and the tree is still clean. Needs docker (or CCDASH_DOCKER, e.g. "sudo -n -u ccdash
# /usr/local/bin/ccdash-docker"), curl and jq. Own project and volumes (ccdashtest-k), removed at the end. Env:
# CCDASH_TEST_PORT (7699), CCDASH_IMAGE (unset: an image ccdash:kitattach is built from the checkout and removed at the end), KEEP=1, DEBUG=1.
# shellcheck disable=SC2329,SC2317,SC1091 # functions run through until_ok / trap; .env.example is a plain env file
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
D=${CCDASH_DOCKER:-docker} # may contain spaces; left unquoted on purpose
export CCDASH_TEST_PORT=${CCDASH_TEST_PORT:-7699}
base=${CCDASH_IMAGE:-}
built=
P=ccdashtest-k

url=http://127.0.0.1:$CCDASH_TEST_PORT
fail=0

compose() { (cd / && $D compose -p "$P" -f - "$@" < <(sed -e "s|@IMAGE@|$CCDASH_TEST_IMAGE|" -e "s|@PORT@|$CCDASH_TEST_PORT|" -e '/# phase-c$/d' "$root/tests/stack/compose.yaml")); }
ccd() { compose exec -T -u ccd -e HOME=/home/ccd ccdash "$@"; }
cleanup() {
  [ -n "${KEEP:-}" ] && return
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  if [ -n "$built" ]; then $D rmi -f "$built" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
until_ok() { # until_ok SECONDS DESCRIPTION CMD...
  local n=$1 what=$2; shift 2
  for _ in $(seq $((n * 5))); do if "$@" >/dev/null 2>&1; then ok "$what"; return 0; fi; sleep 0.2; done
  bad "$what (timed out after ${n}s)"
  if [ -n "${DEBUG:-}" ]; then compose logs --tail 20 || true; fi
  return 1
}
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
tar_ctx() { (cd "$root" && git ls-files -co --exclude-standard -- . ':!dashboard/node_modules' | grep -v '^docs/handoff\|^\.claude' | tar -c -T -); }

if [ -z "$base" ]; then
  base=ccdash:kitattach built=$base
  set -a; . "$root/.env.example"; set +a
  tar_ctx | $D build -q -t "$base" --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION" --build-arg "S6_OVERLAY_VERSION=$S6_OVERLAY_VERSION" --build-arg "BASIC_MEMORY_VERSION=$BASIC_MEMORY_VERSION" --build-arg "KIT_REPO=$KIT_REPO" --build-arg "KIT_REF=$KIT_REF" - >/dev/null
fi
export CCDASH_TEST_IMAGE=$base # the real image: real claude, real kit

compose down -v --remove-orphans >/dev/null 2>&1 || true
healthy() { curl -sf "$url/healthz"; }
ID=(-c user.name=t -c user.email=t@example.com)

echo "== stack up, two local bare remotes"
compose up -d >/dev/null 2>&1
until_ok 60 "dashboard answers /healthz" healthy
for n in demo other; do
  ccd bash -ec "
    B=/home/ccd/bare/$n.git
    mkdir -p /home/ccd/bare && git init -q --bare -b main \$B
    git clone -q \$B /home/ccd/seed-$n 2>/dev/null
    cd /home/ccd/seed-$n && git checkout -q -b main 2>/dev/null || true
    echo one > f && git add f && git ${ID[*]} commit -qm one && git push -q origin main
    git config --global url.\$B.insteadOf https://github.com/octo/$n.git"
done
remote_files() { ccd git --git-dir="/home/ccd/bare/$1.git" ls-tree -r --name-only main; }

echo "== AC-4.1 onboard with the kit on (attach)"
if ccd ccd-onboard --kit octo/demo >/dev/null 2>&1; then ok "AC-4.1 ccd-onboard --kit octo/demo succeeded"; else bad "AC-4.1 ccd-onboard --kit octo/demo failed"; fi
W=/workspace/demo
eq "AC-4.1 git status --porcelain is empty" "$(ccd git -C $W status --porcelain)" ""
eq "AC-4.1 no tracked .claude or CLAUDE.local.md" "$(ccd git -C $W ls-files .claude CLAUDE.local.md)" ""
eq "AC-4.1 exclude has the private block" "$(ccd grep -cx '# agent-kit:private \(start\|end\)' $W/.git/info/exclude)" 2
plugins=$(ccd env CLAUDE_CONFIG_DIR=/home/ccd/.claude-projects/demo claude plugin list 2>&1 || true)
for p in kit-core kit-design kit-code; do
  if grep -q "$p" <<<"$plugins"; then ok "AC-4.1 plugin $p listed"; else bad "AC-4.1 plugin $p missing: $plugins"; fi
done

# No push from the kit-on project: its pre-push hook needs a Claude login. Check what a push would send instead.
echo "== AC-4.2 what a push would send, and the leak guard"
kitre='^\.claude/\|^CLAUDE\.local\.md$\|^AGENTS\.md$\|^docs/handoff/'
ccd bash -ec "cd $W && echo two > g && git add g && git ${ID[*]} commit -qm two && git fetch -q origin"
if head_tree=$(ccd git -C $W ls-tree -r --name-only HEAD); then eq "AC-4.2 HEAD tree has no kit path" "$(grep -c "$kitre" <<<"$head_tree" || true)" 0; else bad "AC-4.2 HEAD tree listing failed"; fi
if ahead=$(ccd git -C $W log --name-only --format= origin/main..HEAD); then eq "AC-4.2 commits ahead of origin/main touch no kit path" "$(grep -c "$kitre" <<<"$ahead" || true)" 0; else bad "AC-4.2 commits-ahead listing failed"; fi
if ccd git -C $W log --name-only --format= origin/main..HEAD | grep -qx g; then ok "AC-4.2 the new file is among the commits to push"; else bad "AC-4.2 g not in the commits to push"; fi
head_before=$(ccd git -C $W rev-parse HEAD)
ccd bash -ec "cd $W && mkdir -p docs/handoff && echo leak > docs/handoff/leak-test.md && git add -f docs/handoff/leak-test.md"
if ccd git -C $W diff --cached --name-only | grep -qx 'docs/handoff/leak-test.md'; then ok "AC-4.2 kit path force-added"; else bad "AC-4.2 force-add did not stage the kit path"; fi
if commit_out=$(ccd git -C $W "${ID[@]}" commit -qm leak 2>&1); then commit_rc=0; else commit_rc=$?; fi
if [ "$commit_rc" -ne 0 ] && grep -qF 'kit-private paths found' <<<"$commit_out"; then ok "AC-4.2 leak guard refused the commit"; else bad "AC-4.2 leak guard did not refuse the commit (rc $commit_rc): $commit_out"; fi
eq "AC-4.2 nothing was committed" "$(ccd git -C $W rev-parse HEAD)" "$head_before"
ccd bash -ec "cd $W && git reset -q && rm -f docs/handoff/leak-test.md" >/dev/null 2>&1 || true

echo "== AC-4.3 onboard with the kit off"
if ccd ccd-onboard --no-kit octo/other >/dev/null 2>&1; then ok "AC-4.3 ccd-onboard --no-kit octo/other succeeded"; else bad "AC-4.3 ccd-onboard --no-kit failed"; fi
O=/workspace/other
ccd bash -ec "cd $O && mkdir -p .claude/agents && echo hi > .claude/agents/x.md && echo hi > AGENTS.md && git add .claude AGENTS.md && git ${ID[*]} commit -qm agent && git push -q origin HEAD:main"
if remote_files other | grep -qx '.claude/agents/x.md'; then ok "AC-4.3 .claude/agents/x.md reached the remote"; else bad "AC-4.3 x.md not on the remote"; fi
if remote_files other | grep -qx 'AGENTS.md'; then ok "AC-4.3 AGENTS.md reached the remote"; else bad "AC-4.3 AGENTS.md not on the remote"; fi
eq "AC-4.3 no exclude block" "$(ccd grep -c 'agent-kit:private' $O/.git/info/exclude || true)" 0

echo "== AC-4.4 restart: the start re-check"
compose restart >/dev/null 2>&1
until_ok 60 "dashboard answers /healthz after the restart" healthy
check_ok() { [ "$(ccd jq -r .kitCheck.status /home/ccd/.ccdash/projects/demo.json)" = ok ]; }
until_ok 180 "AC-4.4 kitCheck status is ok" check_ok
eq "AC-4.4 tree still clean" "$(ccd git -C $W status --porcelain)" ""
exit $fail
