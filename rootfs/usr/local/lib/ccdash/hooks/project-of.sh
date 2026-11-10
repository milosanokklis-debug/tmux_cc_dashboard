# shellcheck shell=bash
# Sourced by the hooks. project_of DIR [WS]: prints the project name, the first directory below the workspace
# (WS, default $CCDASH_WS or /workspace), or nothing when DIR is not under it.
project_of() {
  local d=${1:-} ws=${2:-${CCDASH_WS:-/workspace}}
  case $d in
    "$ws"/?*) d=${d#"$ws"/}; printf '%s\n' "${d%%/*}" ;;
  esac
}
