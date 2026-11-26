#!/bin/bash
# nobase-synth.sh (RQ-NOBASE-SYNTH-1, EO 19:20 Oct 27: dry run first). READ-ONLY: for each worktree under wt/ with no
# $R/<job>.base, print the .base line it would get ("<merge-base> <branch> <wt> synth"), or SKIP <job> <reason>.
# Never writes. Excluded: non RQ-* names (DESKTOP-*, masbot-*, stack-*), *-g1, a g1-pass file, hold list, skip list.
set -u; umask 077
R="$HOME/.ashlr-runs"; WTR="$HOME/Projects/ashlrai/wt"; PROJ="$HOME/Projects/ashlrai"; RULES="$R/ENGINEER-RULES.md"
GS="$R/bin/git-safe-env.sh"; GS_SHA=01e1e5ab72016a5b6fbd96c76cb903eb7c61849084b20ae04374219dcd077331
SKIPLIST="RQ-DISC-SITE-ASHLR RQ-FRESH-SITE-ASHLR RQ-MEASURABLY-OSS-AUDIT-LOCAL RQ-SEO-ASHLR stack-release-dispatch-ff"
sha(){ { /usr/bin/shasum -a 256 "$1" 2>/dev/null || sha256sum "$1" 2>/dev/null; } | awk 'NR==1{print $1}'; }
[ -f "$GS" ] && [ ! -L "$GS" ] && [ "$(sha "$GS")" = "$GS_SHA" ] && . "$GS" && gs_init || { echo "REFUSE: git-safe-env.sh missing or sha mismatch"; exit 3; }
L7=$(grep '^7\. Hold list' "$RULES" 2>/dev/null); [ -n "$L7" ] || { echo "REFUSE: hold list unreadable"; exit 3; }
n=0
for W in "$WTR"/*; do [ -d "$W" ] && [ ! -L "$W" ] || continue; J=${W##*/}
  [ -e "$R/$J.base" ] || [ -L "$R/$J.base" ] && continue
  s(){ echo "SKIP $J $1"; }
  case "$J" in RQ-*) ;; *) s not_rq; continue;; esac
  case "$J" in *-g1|*-g1-*|*[!A-Za-z0-9._-]*) s g1_or_bad_name; continue;; esac
  case " $SKIPLIST " in *" $J "*) s skip_list; continue;; esac
  case "$L7" in *"$J"*) s hold; continue;; esac
  { [ -e "$R/g1-pass/$J.pass" ] || [ -L "$R/g1-pass/$J.pass" ]; } && { s g1_pass; continue; }
  [ -f "$W/.git" ] && [ ! -L "$W/.git" ] || { s no_gitfile; continue; }
  M=$(sed -n '1s|^gitdir: \(.*\)/\.git/worktrees/[^/]*$|\1|p' "$W/.git"); M=$(gs_rp "$M")
  case "$M" in "$PROJ"/*) ;; *) s main_outside_projects; continue;; esac
  gs_check "$(gs_rp "$W")" >/dev/null || { s git_unsafe; continue; }   # refs are shared, so all reads go through the checked worktree
  D=$(gs_git "$W" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
  for c in "$D" origin/main origin/master; do [ -n "$c" ] && gs_git "$W" rev-parse -q --verify "$c^{commit}" >/dev/null 2>&1 && { D=$c; break; }; done
  B=$(gs_git "$W" merge-base HEAD "$D" 2>/dev/null); [[ "$B" =~ ^[0-9a-f]{40}$ ]] || { s no_merge_base; continue; }
  BR=$(gs_git "$W" rev-parse --abbrev-ref HEAD 2>/dev/null); A=$(gs_git "$W" rev-list --count "$B..HEAD" 2>/dev/null)
  n=$((n+1)); echo "SYNTH $J $B ${BR:-?} $W synth repo=${M##*/} default=$D ahead=${A:-?}"
done
echo "SUMMARY synth=$n mode=read-only"
