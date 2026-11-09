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

# kit_recheck_project <proj> [account=default]: re-run the kit (`ccd-onboard --kit-only`: no pull or fetch; HEAD only moves by the kit's own commit) for an opted-in project under the
# account's CLAUDE_CONFIG_DIR, bounded by CCDASH_KIT_TIMEOUT (60s). Always returns 0 and prints nothing (callers' stdout
# may carry data). The outcome goes into the project record as kitCheck {status,message,account,ts}; a failure also sets
# kitError, a success clears it. Needs account_env (accounts.sh) and runs ccd-onboard from this script's directory ($0).
kit_recheck_project() {
  local proj=$1 acct=${2:-default} f repo out rc=0 t line status ts w code
  f=${CCDASH_PROJECTS:-$HOME/.ccdash/projects}/$proj.json
  [ -f "$f" ] || return 0
  jq -e 'if type != "object" then false elif .kitEnabled == true then true elif .kitEnabled == false then false else (.kit != null and .kit != false) end' "$f" > /dev/null 2>&1 || return 0
  repo=$(jq -r '.repo // empty' "$f" 2> /dev/null || true)
  [ -n "$repo" ] || return 0
  t=${CCDASH_KIT_TIMEOUT:-60}; w=$((t / 2)); [ "$w" -le 10 ] || w=10; [ "$w" -ge 1 ] || w=1
  out=$( (account_env "$acct" && CCDASH_KIT_LOCK_WAIT=$w timeout -k 5 "$t" "$(dirname "$0")/ccd-onboard" --kit-only "$repo" < /dev/null 2>&1) ) || rc=$?
  line=$(printf '%s\n' "$out" | grep -m1 -E '^kit(-error)? ' || true)
  [ -n "$line" ] || line=$(printf '%s\n' "$out" | grep -m1 . || true)
  line=$(printf '%s' "$line" | tr -d '[:cntrl:]' | cut -c1-200)
  code=$rc
  if [[ $line =~ ^kit-error\ ([0-9]+)\ (.*)$ ]]; then code=${BASH_REMATCH[1]}; line=${BASH_REMATCH[2]}; fi
  if [ "$rc" = 0 ]; then
    status=ok; [[ $line == "kit "*" changed"* ]] && status=changed
  else
    status=failed
    case $rc in
      124 | 137) code=$rc; line="timed out after ${t}s" ;;
    esac
  fi
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  (
    exec 9> "$(kit_lock_dir)/kit-$proj.lock" || exit 0
    flock -w 2 9 || true  # lock held by a kit run: still record (atomic mv)
    [ -f "$f" ] || exit 0
    jq --arg s "$status" --arg m "$line" --arg a "$acct" --arg ts "$ts" --argjson rc "$code" '
      .kitCheck = {status: $s, message: $m, account: $a, ts: $ts}
      | if $s == "failed" then .kitError = {code: $rc, message: $m} else del(.kitError) end' "$f" > "$f.tmp.$$" 2> /dev/null \
      && mv "$f.tmp.$$" "$f" || rm -f "$f.tmp.$$"
  ) > /dev/null 2>&1 || true
  return 0
}
