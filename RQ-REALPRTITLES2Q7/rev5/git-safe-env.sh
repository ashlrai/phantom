#!/bin/bash
# git-safe-env.sh (RQ-GIT-SAFE, Security G1 on REAPER-12): run read-only git on a job worktree without executing
# anything the worktree or its repo config can plant (clean/smudge filters, textconv, fsmonitor, hooks, pagers,
# includes). Bash 3.2 safe. Two ways to use it:
#   source:  . git-safe-env.sh; gs_init; reason=$(gs_check "$WT") || skip; gs_git "$WT" status --porcelain
#   cli:     git-safe-env.sh check <wt>                 -> "OK" exit 0 | "UNSAFE <reason>" exit 1
#            git-safe-env.sh run <wt> <status|diff|rev-list|rev-parse> [args...]  (check first, then git; exit 1 if unsafe)
# Fail closed: any error, unreadable file or unexpected layout is UNSAFE.
# rev4.1 (Security): before anything else, drop command-line style config from the env and pin the config scope.
unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS
for __gs_v in $(compgen -e | grep -E '^GIT_CONFIG_(KEY|VALUE)_'); do unset "$__gs_v"; done; unset __gs_v
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
GS_ROOT_DEFAULT="$HOME/Projects/ashlrai"
gs_rp(){ ( cd -P -- "$1" 2>/dev/null && pwd -P ); }
GS_REPOS='phantom|phantom-secrets|ashlr-plugin|locus|lexicon|ashlr-md|ashlr-stack'   # rev3: same 7 as reap-merged REPOS
GS_GIT_FIXED=/usr/bin/git   # rev2 S3: the ONLY git ever executed. Never /opt/homebrew, never PATH.
gs_init(){ # any argument is ignored (rev2 S3). Sanitizes the environment of the current shell.
  GS_GIT=$GS_GIT_FIXED
  local v
  for v in $(compgen -e | grep "^GIT_"); do
    unset "$v"                         # every GIT_* variable goes (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_EXTERNAL_DIFF, ...)
  done
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_ATTR_NOSYSTEM=1
  unset PAGER GIT_PAGER EDITOR VISUAL
  unset HTTPS_PROXY HTTP_PROXY ALL_PROXY NO_PROXY CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR https_proxy http_proxy all_proxy no_proxy curl_ca_bundle ssl_cert_file ssl_cert_dir   # rev4.1 A-2
  GS_REPO_ROOT=$(gs_rp "${GS_REPO_ROOT_DIR:-$GS_ROOT_DEFAULT}")
  if [ ! -f "$GS_GIT" ] || [ ! -x "$GS_GIT" ]; then echo "git-safe: git_unavailable $GS_GIT_FIXED missing, failing closed" >&2; GS_GIT=""; return 1; fi
  return 0
}
gs_git(){ # $1 wt, rest = git args. Only call after gs_check passed.
  local w=$1; shift
  "$GS_GIT" --no-optional-locks --no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null \
    -c diff.external= -c core.pager=cat -c core.untrackedCache=false \
    -c status.recurseSubmodules=false -c diff.ignoreSubmodules=all -c submodule.recurse=false -C "$w" "$@"   # rev3 GS1
}
gs_check(){ # $1 wt (absolute, real path). Prints a reason and fails if unsafe.
  local w=$1 gl gd cd cm back out line key f n raw pu
  [ -n "${GS_GIT:-}" ] || { echo gs_not_initialized; return 1; }
  [ -n "${GS_REPO_ROOT:-}" ] || { echo no_repo_root; return 1; }
  case "$w" in /*) ;; *) echo relative_wt; return 1;; esac
  [ -d "$w" ] && [ ! -L "$w" ] && [ "$(gs_rp "$w")" = "${w%/}" ] || { echo wt_not_real_dir; return 1; }
  # ---- gitlink: WT/.git is a regular file "gitdir: <common>/worktrees/<name>", which points back at WT/.git
  gl="$w/.git"
  [ -f "$gl" ] && [ ! -L "$gl" ] || { echo gitlink_not_file; return 1; }
  [ "$(wc -l < "$gl" | tr -d ' ')" -le 1 ] || { echo gitlink_bad; return 1; }
  gd=$(sed -n '1s/^gitdir: \(\/.*\)$/\1/p' "$gl"); [ -n "$gd" ] || { echo gitlink_bad; return 1; }
  [ -d "$gd" ] && [ ! -L "$gd" ] && [ "$(gs_rp "$gd")" = "${gd%/}" ] || { echo gitdir_not_real; return 1; }
  [ -f "$gd/commondir" ] && [ ! -L "$gd/commondir" ] || { echo commondir_missing; return 1; }
  cm=$(head -1 "$gd/commondir"); case "$cm" in /*) ;; *) cm="$gd/$cm";; esac
  cd=$(gs_rp "$cm"); [ -n "$cd" ] || { echo commondir_bad; return 1; }
  case "$gd" in "$cd/worktrees/"*) n=${gd#"$cd/worktrees/"}; case "$n" in ""|*/*) echo gitdir_not_in_common; return 1;; esac;; *) echo gitdir_not_in_common; return 1;; esac
  case "$cd" in "$GS_REPO_ROOT"/*/.git) n=${cd#"$GS_REPO_ROOT"/}; n=${n%/.git}; case "$n" in ""|*/*) echo common_not_repo_root_child; return 1;; esac;;
    *) echo common_not_repo_root_child; return 1;; esac
  [ -f "$gd/gitdir" ] && [ ! -L "$gd/gitdir" ] || { echo backlink_missing; return 1; }
  back=$(head -1 "$gd/gitdir"); [ "$back" = "$w/.git" ] || { echo backlink_mismatch; return 1; }
  # ---- config: a read that runs nothing. Deny any key that can execute or pull in more config.
  out=$("$GS_GIT" --no-optional-locks -C "$w" config --list --show-origin --name-only 2>/dev/null) || { echo git_config_error; return 1; }
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    key=$(printf '%s' "${line#*	}" | tr 'A-Z' 'a-z')
    case "$key" in
      filter.*|include.*|includeif.*|pager.*|diff.external|merge.*.driver) echo "git_config_unsafe:${key%%.*}"; return 1;;
      diff.*.textconv|diff.*.command) echo git_config_unsafe:diff; return 1;;
      gpg.program|gpg.*.program|credential.*|url.*.insteadof|url.*.pushinsteadof|protocol.*|uploadpack.*|receivepack.*|remote.*.uploadpack|remote.*.receivepack|core.worktree) echo "git_config_unsafe:$key"; return 1;;
      http.*|https.*) echo "git_config_unsafe:http.${key##*.}"; return 1;;   # rev4.1 A-1: every http.*/https.* key, no caller needs one
      core.fsmonitor|core.hookspath|core.sshcommand|core.pager|core.editor|core.attributesfile|core.gitproxy|core.askpass|core.alternaterefscommand) echo "git_config_unsafe:$key"; return 1;;
    esac
  done <<GSCFG
$out
GSCFG
  pu=0
  # ---- rev3 P1: every remote.*.url must be a plain https github URL of an allowlisted repo (callers never need others)
  while IFS= read -r -d '' line; do
    raw=${line%%$'\n'*}; key=$(printf '%s' "$raw" | tr 'A-Z' 'a-z')
    case "$key" in remote.*.pushurl)
      [ "$raw" = remote.origin.pushurl ] && [ "$line" = "remote.origin.pushurl"$'\n'"no_push" ] || { echo git_config_unsafe:pushurl; return 1; }
      pu=$((pu+1)); [ "$pu" -le 1 ] || { echo git_config_unsafe:pushurl_multi; return 1; }; continue;; esac
    case "$key" in remote.*.url) ;; *) continue;; esac
    case "$line" in *$'\n'*) ;; *) echo git_config_unsafe:remote_url; return 1;; esac
    [[ "${line#*$'\n'}" =~ ^https://github\.com/(ashlrai|masonwyatt23)/($GS_REPOS)(\.git)?$ ]] || { echo git_config_unsafe:remote_url; return 1; }
  done < <("$GS_GIT" --no-optional-locks -C "$w" config --list -z 2>/dev/null)   # read the stream: $(...) would drop the NULs
  # ---- rev3 GS1: submodules can carry their own config and attributes; refuse any sign of one (fail closed)
  [ -e "$w/.gitmodules" ] || [ -L "$w/.gitmodules" ] && { echo submodule_gitmodules; return 1; }
  [ -e "$cd/modules" ] || [ -L "$cd/modules" ] || [ -e "$gd/modules" ] || [ -L "$gd/modules" ] && { echo submodule_modules_dir; return 1; }
  out=$(find -P "$w" -xdev -mindepth 2 -maxdepth 40 -iname .git -print 2>/dev/null) || { echo nested_find_error; return 1; }
  [ -z "$out" ] || { echo submodule_nested_git; return 1; }
  # ---- attributes: no filter= anywhere git could read it (in-tree, bounded, no symlink following; info/attributes)
  for f in "$cd/info/attributes" "$gd/info/attributes"; do
    [ -L "$f" ] && { echo attributes_symlink; return 1; }
    [ -e "$f" ] || continue
    [ -f "$f" ] && [ -r "$f" ] || { echo attributes_unreadable; return 1; }
    grep -aqE 'filter[[:space:]]*=' "$f" && { echo attributes_filter; return 1; }
  done
  out=$(find -P "$w" -xdev -maxdepth 40 -name .git -prune -o -name .gitattributes -print 2>/dev/null) || { echo attributes_find_error; return 1; }
  [ "$(printf '%s\n' "$out" | grep -c .)" -le 5000 ] || { echo attributes_too_many; return 1; }
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ -L "$f" ] && { echo attributes_symlink; return 1; }
    [ -f "$f" ] && [ -r "$f" ] || { echo attributes_unreadable; return 1; }
    grep -aqE 'filter[[:space:]]*=' "$f" && { echo attributes_filter; return 1; }
  done <<GSATTR
$out
GSATTR
  return 0
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then   # cli mode
  set -u; umask 077; export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
  gs_init || { echo "UNSAFE no_git"; exit 1; }
  cmd=${1:-}; w=${2:-}; [ -n "$w" ] || { echo "usage: git-safe-env.sh check|run <wt> ..." >&2; exit 2; }
  why=$(gs_check "$w") || { echo "UNSAFE $why"; exit 1; }
  case "$cmd" in
    check) echo OK; exit 0;;
    run) shift 2; case "${1:-}" in status|diff|rev-list|rev-parse) ;; *) echo "UNSAFE subcommand"; exit 1;; esac
         [ "$1" = diff ] && { shift; set -- diff --no-ext-diff --no-textconv --ignore-submodules=all "$@"; }
         [ "$1" = status ] && { shift; set -- status --ignore-submodules=all "$@"; }
         gs_git "$w" "$@"; exit $?;;
    *) echo "usage: git-safe-env.sh check|run <wt> ..." >&2; exit 2;;
  esac
fi
