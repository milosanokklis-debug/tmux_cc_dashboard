#!/usr/bin/env bash
# Checks the commands shown in README.md code blocks against bin/ccd and setup.sh.
# Env: DOCS_README overrides the README path. Exit nonzero on any unknown subcommand or flag.
set -uo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readme=${DOCS_README:-$root/README.md}
ccd=$root/bin/ccd
setup=$root/setup.sh
[ -f "$readme" ] || { echo "FAIL no README at $readme"; exit 1; }

fail=0 checked=0
infence=0
while IFS= read -r line; do
  case $line in
    '```'*) infence=$((1 - infence)); continue ;;
  esac
  [ $infence -eq 1 ] || continue
  line=${line#"${line%%[![:space:]]*}"}
  line=${line#\$ }
  line=${line%% \#*}
  set -f # no globbing in the word split
  # shellcheck disable=SC2206
  words=($line)
  set +f
  case $line in
    "ccd "*)
      sub=${words[1]:-}
      if ! grep -Eq "^[[:space:]]*([a-z|-]*\\|)?${sub}(\\|[a-z|-]*)?\\)" "$ccd"; then
        echo "FAIL ccd subcommand '$sub' is not a case label in bin/ccd: $line"; fail=1
      fi
      target=$ccd ;;
    "sudo ./setup.sh"* | "./setup.sh"*)
      [ -f "$setup" ] || { echo "FAIL setup.sh is missing: $line"; fail=1; continue; }
      target=$setup ;;
    *) continue ;;
  esac
  checked=$((checked + 1))
  for w in "${words[@]}"; do
    case $w in --[a-zA-Z]*)
      flag=${w%%=*}
      grep -Eq -- "(^|[^A-Za-z0-9-])${flag}([^A-Za-z0-9-]|\$)" "$target" || { echo "FAIL flag '$flag' not found in ${target##*/}: $line"; fail=1; }
    esac
  done
done <"$readme"

if [ "$checked" -lt 1 ]; then echo "FAIL README has no checked commands (found $checked)"; fail=1; fi
echo "docs-check: $checked command(s) checked"
exit $fail
