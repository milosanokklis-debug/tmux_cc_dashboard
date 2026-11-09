# shellcheck shell=bash
# Claude accounts, sourced (not executed). `default` is /home/ccd/.claude with CLAUDE_CONFIG_DIR unset;
# every other account lives in $CCDASH_ACCOUNTS_DIR/<name> and runs with CLAUDE_CONFIG_DIR set to it.
# Interface: account_valid NAME | account_config_dir NAME | account_env NAME | account_list | account_create NAME | account_of_config_dir [DIR]

CCDASH_ACCOUNTS_DIR=${CCDASH_ACCOUNTS_DIR:-/home/ccd/.claude-accounts}

# Succeeds for `default` and for a creatable name.
account_valid() {
  [ "$1" = default ] || [[ $1 =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]
}

# Prints the config dir; prints nothing for `default` (leave CLAUDE_CONFIG_DIR unset). Fails on a bad name.
account_config_dir() {
  account_valid "$1" || return 1
  [ "$1" = default ] || printf '%s\n' "$CCDASH_ACCOUNTS_DIR/$1"
}

# Exports CLAUDE_CONFIG_DIR for the account, or unsets it for `default`. Fails on a bad name.
# Call it in a subshell when the caller's environment must stay as it is.
account_env() {
  local dir
  dir=$(account_config_dir "$1") || return 1
  if [ -n "$dir" ]; then export CLAUDE_CONFIG_DIR=$dir; else unset CLAUDE_CONFIG_DIR; fi
}

# Prints the account a config dir belongs to (default $CLAUDE_CONFIG_DIR): its name when it is
# <accounts>/<valid name>, otherwise `default`.
account_of_config_dir() {
  local d=${1-${CLAUDE_CONFIG_DIR:-}} a=default
  case $d in
    "$CCDASH_ACCOUNTS_DIR"/*)
      a=${d#"$CCDASH_ACCOUNTS_DIR"/}
      [[ $a =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]] || a=default ;;
  esac
  printf '%s\n' "$a"
}

# One name per line: default first, then the existing account dirs sorted.
account_list() {
  local d
  echo default
  [ -d "$CCDASH_ACCOUNTS_DIR" ] || return 0
  for d in "$CCDASH_ACCOUNTS_DIR"/*/; do
    d=${d%/}
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    d=${d##*/}
    account_valid "$d" && [ "$d" != default ] && echo "$d"
  done | LC_ALL=C sort
}

# Creates the account dir (0700, the caller's user). Idempotent. `default`, bad names and symlinks fail.
account_create() {
  [ "$1" != default ] && account_valid "$1" || return 1
  [ ! -L "$CCDASH_ACCOUNTS_DIR/$1" ] || return 1
  (
    umask 077
    mkdir -p "$CCDASH_ACCOUNTS_DIR/$1" && chmod 0700 "$CCDASH_ACCOUNTS_DIR/$1"
  )
}
