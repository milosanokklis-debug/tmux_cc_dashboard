# shellcheck shell=bash
# Sourced helper (never executed): where the active agent kit lives and which upstream marketplaces it pins.
# The kit script is only read as text here, never sourced or run.
# CCDASH_KIT_HOME (default /home/ccd/.ccdash/kit): its `current` dir, when it holds agent-kit.sh, wins over the image copy.

kit_script() {
  local cur=${CCDASH_KIT_HOME:-/home/ccd/.ccdash/kit}/current
  if [ -f "$cur/agent-kit.sh" ]; then printf '%s\n' "$cur/agent-kit.sh"; else printf '%s\n' /opt/agent-kit/agent-kit.sh; fi
}

# kit_upstream_marketplaces [script]: `name=owner/repo` rows from the UPSTREAM_MARKETPLACES=( ... ) array of the kit
# script. Comments (# to end of line) are ignored; the one-line form works too. An array with no closing `)` gives
# no rows, so nothing after it is read. Falls back to the kit 0.9.2 list when the array is missing, unterminated,
# empty or has no valid row.
kit_upstream_marketplaces() {
  local f=${1:-$(kit_script)} rows=''
  if [ -r "$f" ]; then
    rows=$(awk '
      /^[[:space:]]*UPSTREAM_MARKETPLACES=\(/ && !seen { seen = 1; inarr = 1; sub(/^[^(]*\(/, "") }
      inarr {
        sub(/#.*/, "")
        if (index($0, ")")) { sub(/\).*/, ""); buf = buf " " $0; closed = 1; inarr = 0; next }
        buf = buf " " $0
      }
      END { if (closed) print buf }' "$f" 2> /dev/null \
      | tr -d '"'"'" | tr -s '[:space:]' '\n' \
      | grep -E '^[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || true)
  fi
  if [ -z "$rows" ]; then
    rows='addy-agent-skills=addyosmani/agent-skills
superpowers-marketplace=obra/superpowers-marketplace
mattpocock=mattpocock/skills
hallmark=Nutlope/hallmark
design-plugins=0xdesign/design-plugin'
  fi
  printf '%s\n' "$rows"
}

# kit_version <script>: the x.y.z of the `KIT_VERSION="x.y.z"` line, read as text (the kit has no --version flag and is
# never run for this). Prints nothing and fails when the file or a strictly formed line is missing.
kit_version() {
  local v
  v=$(sed -n 's/^KIT_VERSION="\([0-9A-Za-z._-][0-9A-Za-z._-]*\)"$/\1/p' "$1" 2> /dev/null | head -n 1) || true
  [ -n "$v" ] && printf '%s\n' "$v"
}

# kit_lock_dir: $CCDASH_LOCK_DIR, else /run/ccdash when writable, else $HOME/.ccdash/locks. Created if needed.
kit_lock_dir() {
  local d=${CCDASH_LOCK_DIR:-/run/ccdash}
  if ! { mkdir -p "$d" && [ -w "$d" ]; } 2> /dev/null; then d=$HOME/.ccdash/locks; mkdir -p "$d"; fi
  printf '%s\n' "$d"
}
