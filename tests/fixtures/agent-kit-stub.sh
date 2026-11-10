#!/usr/bin/env bash
# Stand-in for /opt/agent-kit/agent-kit.sh, same `ensure` contract as the real kit (agent-kit 0.9.2):
#   agent-kit-stub.sh ensure <path> [design] [code] --json
# Progress goes to stderr, the last stdout line is the result JSON. Writes only .claude/settings.json,
# .claude/agent-kit.json, CLAUDE.md and (design only) .claude/skills/web-design-guidelines/; leaving design out
# removes the kit-design entry and the vendored skill. Idempotent: "changed" is false when nothing differs.
# Env: KIT_REPO (marketplace repo, default octo/kit), STUB_VERSION (0.9.2), STUB_MEMORY (connected),
# STUB_LOG=<file> (appends the arguments and env it saw), STUB_SECRET (printed to stderr on failure, to test redaction), STUB_EXIT=2..6 (write some junk first, then fail with the real kit's JSON line and exit code).
set -euo pipefail
# attach/detach imitate agent-kit 0.14.0 no-trace mode: nothing tracked is written, the private paths go into
# .git/info/exclude between `# agent-kit:private start/end`, the rest in .claude/settings.local.json,
# .claude/agent-kit.json (version from STUB_VERSION, default 0.14.0) and CLAUDE.local.md. No --json: human lines
# on stdout, warnings on stderr. A tracked private path gets a warning and is left alone (and out of the block).
# STUB_EXIT=<n> (any value) makes attach scribble nothing, print a message on stderr and exit with that code.
kit_attach_detach() {
  local cmd=$1 dir=${2:-} ex path keep=()
  if [ ! -e "$dir/.git" ]; then echo "$dir is not a git work tree" >&2; return 2; fi
  ex=$(git -C "$dir" rev-parse --git-path info/exclude); case $ex in /*) ;; *) ex=$dir/$ex ;; esac
  mkdir -p "$(dirname "$ex")"; touch "$ex"
  awk '/^# agent-kit:private start$/{skip=1} !skip{print} /^# agent-kit:private end$/{skip=0}' "$ex" > "$ex.tmp"; mv "$ex.tmp" "$ex"
  if [ "$cmd" = detach ]; then
    rm -f "$dir/.claude/agent-kit.json" "$dir/.claude/settings.local.json" "$dir/CLAUDE.local.md"
    echo "detached $dir"; return 0
  fi
  if [ -n "${STUB_EXIT:-}" ]; then
    echo "stub: attach failed with ${STUB_EXIT}" >&2
    [ -z "${STUB_SECRET:-}" ] || echo "using token=${STUB_SECRET} Bearer ${STUB_SECRET}" >&2
    return "$STUB_EXIT"
  fi
  for path in .claude/agents/{Explore,orchestrator,lead,supervisor,solo,ui-guide}.md .claude/agent-kit.json \
    .claude/settings.local.json CLAUDE.local.md docs/handoff/ graphify-out/; do
    if [ -n "$(git -C "$dir" ls-files -- "$path" | head -n1)" ]; then
      echo "warning: $path is tracked in $dir — left out of the exclude block, the tracked file is untouched" >&2
    else keep+=("/$path"); fi
  done
  { echo "# agent-kit:private start"; printf '%s\n' "${keep[@]}"; echo "# agent-kit:private end"; } >> "$ex"
  mkdir -p "$dir/.claude"
  echo '{"enabledPlugins":{"kit-core@agent-kit":true}}' > "$dir/.claude/settings.local.json"
  jq -n --arg v "${STUB_VERSION:-0.14.0}" '{kit_version: $v, packs: ["kit-core","kit-design","kit-code"]}' > "$dir/.claude/agent-kit.json"
  echo "agent-kit attached" > "$dir/CLAUDE.local.md"
  echo "attached $dir (kit ${STUB_VERSION:-0.14.0}, memory ${STUB_MEMORY:-connected})"
}
[ -z "${STUB_LOG:-}" ] || echo "args=$* NO_COLOR=${NO_COLOR:-} TMPDIR=${TMPDIR:-} KIT_REPO=${KIT_REPO:-}" >> "$STUB_LOG"
case "${1:-}" in
  attach | detach) kit_attach_detach "$@"; exit $? ;;
  ensure) ;;
  *) echo "usage" >&2; exit 2 ;;
esac
shift
proj='' design=0 code=0
for a in "$@"; do
  case $a in design) design=1 ;; code) code=1 ;; --json) ;; *) proj=$a ;; esac
done
KIT_NAME=agent-kit
repo=${KIT_REPO:-octo/kit}
ver=${STUB_VERSION:-0.9.2}
if [ ! -d "$proj" ] || [ ! -e "$proj/.git" ]; then
  echo "not a git root" >&2; printf '{"ok":false,"code":2,"error":"not a git root"}\n'; exit 2
fi
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
if [ -z "${STUB_NO_CLAUDEMD:-}" ]; then # STUB_NO_CLAUDEMD=1: write only .claude/ (no CLAUDE.md)
touch CLAUDE.md
awk '/<!-- agent-kit:start -->/{skip=1} !skip{print} /<!-- agent-kit:end -->/{skip=0}' CLAUDE.md > CLAUDE.md.tmp
printf '<!-- agent-kit:start -->\nagent-kit %s packs: %s\n<!-- agent-kit:end -->\n' "$ver" "$csv" >> CLAUDE.md.tmp
mv CLAUDE.md.tmp CLAUDE.md
fi
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
