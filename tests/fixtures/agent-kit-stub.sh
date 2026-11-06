#!/usr/bin/env bash
# Stand-in for /opt/agent-kit/agent-kit.sh, same `ensure` contract as the real kit (agent-kit 0.9.2):
#   agent-kit-stub.sh ensure <path> [design] [code] --json
# Progress goes to stderr, the last stdout line is the result JSON. Writes only .claude/settings.json,
# .claude/agent-kit.json, CLAUDE.md and (design only) .claude/skills/web-design-guidelines/; leaving design out
# removes the kit-design entry and the vendored skill. Idempotent: "changed" is false when nothing differs.
# Env: KIT_REPO (marketplace repo, default octo/kit), STUB_VERSION (0.9.2), STUB_MEMORY (connected),
# STUB_LOG=<file> (appends the arguments and env it saw), STUB_SECRET (printed to stderr on failure, to test redaction), STUB_EXIT=2..6 (write some junk first, then fail with the real kit's JSON line and exit code).
set -euo pipefail
[ -z "${STUB_LOG:-}" ] || echo "args=$* NO_COLOR=${NO_COLOR:-} TMPDIR=${TMPDIR:-} KIT_REPO=${KIT_REPO:-}" >> "$STUB_LOG"
[ "${1:-}" = ensure ] || { echo "usage" >&2; exit 2; }
shift
proj='' design=0 code=0
for a in "$@"; do
  case $a in design) design=1 ;; code) code=1 ;; --json) ;; *) proj=$a ;; esac
done
KIT_NAME=agent-kit
repo=${KIT_REPO:-octo/kit}
ver=${STUB_VERSION:-0.9.2}
[ -d "$proj" ] && [ -e "$proj/.git" ] || { echo "not a git root" >&2; printf '{"ok":false,"code":2,"error":"not a git root"}\n'; exit 2; }
cd "$proj"
snap() { { find .claude -type f 2> /dev/null; [ ! -f CLAUDE.md ] || echo CLAUDE.md; } | sort | xargs -r sha256sum | sha256sum; }
before=$(snap)
mkdir -p .claude
if [ -n "${STUB_EXIT:-}" ]; then
  echo "stub: scribbling then failing with ${STUB_EXIT}" >&2
  [ -z "${STUB_SECRET:-}" ] || echo "using token=${STUB_SECRET} Bearer ${STUB_SECRET}" >&2
  echo '{"junk":true}' > .claude/settings.json
  echo junk >> CLAUDE.md
  mkdir -p .claude/skills/web-design-guidelines; echo junk > .claude/skills/web-design-guidelines/SKILL.md
  printf '{"ok":false,"code":%s,"error":"stub failure %s"}\n' "$STUB_EXIT" "$STUB_EXIT"
  exit "$STUB_EXIT"
fi
packs=(kit-core); [ "$design" = 0 ] || packs+=(kit-design); [ "$code" = 0 ] || packs+=(kit-code)
csv=$(IFS=,; echo "${packs[*]}")
jq -n --arg kit "$KIT_NAME" --arg repo "$repo" --arg packs "$csv" '
  {extraKnownMarketplaces: {($kit): {source: {source: "github", repo: $repo}}},
   enabledPlugins: ([$packs | split(",")[] | {(. + "@" + $kit): true}] | add)}' > .claude/settings.json.new
if [ -f .claude/settings.json ]; then # keep what the project already had, like the real kit
  jq -s '.[0] as $old | .[1] as $new | $old
    | .extraKnownMarketplaces = (($old.extraKnownMarketplaces // {}) + $new.extraKnownMarketplaces)
    | .enabledPlugins = ((($old.enabledPlugins // {}) | with_entries(select(.key | test("^kit-(design|code)@") | not))) + $new.enabledPlugins)' \
    .claude/settings.json .claude/settings.json.new > .claude/settings.json.tmp
else mv .claude/settings.json.new .claude/settings.json.tmp; fi
rm -f .claude/settings.json.new; mv .claude/settings.json.tmp .claude/settings.json
jq -n --arg v "$ver" --arg p "$csv" '{kit_version: $v, packs: ($p | split(","))}' > .claude/agent-kit.json
# CLAUDE.md: replace the marker block, keep the rest
touch CLAUDE.md
awk '/<!-- agent-kit:start -->/{skip=1} !skip{print} /<!-- agent-kit:end -->/{skip=0}' CLAUDE.md > CLAUDE.md.tmp
printf '<!-- agent-kit:start -->\nagent-kit %s packs: %s\n<!-- agent-kit:end -->\n' "$ver" "$csv" >> CLAUDE.md.tmp
mv CLAUDE.md.tmp CLAUDE.md
if [ "$design" = 1 ]; then
  mkdir -p .claude/skills/web-design-guidelines
  echo '*' > .claude/skills/web-design-guidelines/.gitignore
  echo "# web-design-guidelines (stub)" > .claude/skills/web-design-guidelines/SKILL.md
else
  rm -rf .claude/skills/web-design-guidelines
  rmdir .claude/skills 2> /dev/null || true
fi
after=$(snap)
changed=false; [ "$before" = "$after" ] || changed=true
echo "stub: ensure done (changed=$changed)" >&2
printf '{"ok":true,"changed":%s,"kit_version":"%s","installed":[],"updated":[],"removed":[],"files":[],"memory":"%s"}\n' "$changed" "$ver" "${STUB_MEMORY:-connected}"
