# shellcheck shell=bash
# Per-project Claude config dir, sourced (not executed). Project <p> keeps its login and settings in
# ${CCDASH_CONFIG_ROOT:-/home/ccd/.claude-projects}/<p> (mode 0700, owned by the calling user, ccd in production);
# every claude call for the project runs with CLAUDE_CONFIG_DIR set to it.
# Interface: project_valid NAME | project_config_dir NAME | project_config_create NAME | project_env NAME | project_list

CCDASH_CONFIG_ROOT=${CCDASH_CONFIG_ROOT:-/home/ccd/.claude-projects}

project_valid() {
  [[ $1 =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] && [[ $1 != *..* ]]
}

# Prints the config dir. Fails on a bad name.
project_config_dir() {
  project_valid "$1" || return 1
  printf '%s\n' "$CCDASH_CONFIG_ROOT/$1"
}

# Creates the dir (0700, the caller's user). Idempotent. Bad names and symlinks fail.
project_config_create() {
  local d
  d=$(project_config_dir "$1") || return 1
  [ ! -L "$d" ] || return 1
  (
    umask 077
    mkdir -p "$d" && chmod 0700 "$d"
  )
}

# One name per line: the existing project config dirs (real directories only), sorted.
project_list() {
  local d
  for d in "$CCDASH_CONFIG_ROOT"/*/; do
    d=${d%/}
    if [ ! -d "$d" ] || [ -L "$d" ]; then continue; fi
    d=${d##*/}
    if project_valid "$d"; then echo "$d"; fi
  done | LC_ALL=C sort
}

# Exports CLAUDE_CONFIG_DIR for the project. Call it in a subshell when the caller's environment must stay as it is.
project_env() {
  local d
  d=$(project_config_dir "$1") || return 1
  export CLAUDE_CONFIG_DIR=$d
}
