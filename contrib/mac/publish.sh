#!/bin/bash
# usage: publish.sh <job-id>  -> writes ~/.ashlr-runs/<job>.publish
J=${1:-}
[[ "$J" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$J" != *..* ]] || { echo "RESULT ABORT bad-job-id"; exit 1; }
R=~/.ashlr-runs; OUT=$R/$J.publish; exec >"$OUT" 2>&1; set -o pipefail
IM=0; IU=0; IMLOCK=""
case "${2:-}" in "") ;; --integrated-merge) IM=1;; --integrated-upstream-original157|--integrated-upstream-feature) IM=1; IU=1;; *) echo "RESULT ABORT unknown-mode"; exit 1;; esac
[ "$#" -le 2 ] || { echo "RESULT ABORT extra-arguments"; exit 1; }
# RQ-SEC-RUNLOG-SCRUB: scrub this run log on exit; install/test logs are piped through scrub.pl
SCRUB="perl $R/bin/scrub.pl"; trap '[ -z "$IMLOCK" ] || rmdir "$IMLOCK" 2>/dev/null; $SCRUB < "$OUT" > "$OUT.s" && mv "$OUT.s" "$OUT"' EXIT
read BASE BR WT POOL < $R/$J.base
[ -z "$BASE" ] && { echo "RESULT ABORT empty-base"; exit 1; }
cd "$WT" || { echo "RESULT ABORT no-wt"; exit 1; }
# RQ-GIT-SAFE (NEEDS MASON'S OK): every git call below goes through the pinned helper after gs_check of the worktree
# (gitlink/commondir verified, no filter/textconv/fsmonitor/hooks/include config, no filter= attributes, GIT_* env scrubbed).
GS="$R/bin/git-safe-env.sh"; GS_SHA=234fb12a57a51fdfed81da8702a0b452c183f2726582608b81b7e811a65ce1a2   # GIT-SAFE rev4.1
{ [ -f "$GS" ] && [ ! -L "$GS" ] && [ "$( { /usr/bin/shasum -a 256 "$GS" 2>/dev/null || sha256sum "$GS" 2>/dev/null; } | awk 'NR==1{print $1}')" = "$GS_SHA" ] && . "$GS" && gs_init; } || { echo "RESULT ABORT git-safe-unavailable"; exit 1; }
GSWHY=$(gs_check "$WT") || { echo "RESULT ABORT git-unsafe $GSWHY"; exit 1; }
git(){ gs_git "$WT" "$@"; }
# >>> DEPENDENCY_LINK_GUARD
# A trailing-slash node_modules ignore rule does not ignore a symlink with
# that name. Reject staged dependency-directory links before any publication;
# ordinary checked-in package fixtures inside node_modules remain valid.
verify_dependency_links() (
  set -o pipefail
  git ls-files --stage -z | perl -0ne '
    chomp;
    $bad ||= /\A120000 [0-9a-f]{40,64} [0-3]\t(?:.*\/)?node_modules\z/s;
    END { exit($bad ? 1 : 0) }
  '
)
# <<< DEPENDENCY_LINK_GUARD
# commit identity: read (runs nothing, no includes) from the user's ~/.gitconfig as a plain file, passed explicitly as -c; global config is otherwise off
GUN=$("$GS_GIT" config --file "$HOME/.gitconfig" --get user.name 2>/dev/null); GUE=$("$GS_GIT" config --file "$HOME/.gitconfig" --get user.email 2>/dev/null)
# rev3 P1: NAME and REPO come only from dispatchd's own job record ($R/queue/run/<J>.line, the ready.tsv line:
# J<TAB>repo<TAB>lane<TAB>tier...), never from git config or an origin url. NAME must be on the 7-repo allowlist and the
# worktree's common dir must be exactly ~/Projects/ashlrai/$NAME/.git. Push goes to a literal URL, never a remote name.
JL="$R/queue/run/$J.line"; [ -f "$JL" ] && [ ! -L "$JL" ] || { echo "RESULT ABORT no-job-record"; exit 1; }
IFS=$'\t' read -r LJ NAME LX < "$JL"
[ "$LJ" = "$J" ] || { echo "RESULT ABORT job-record-mismatch"; exit 1; }
case "$NAME" in phantom|phantom-secrets|ashlr-plugin|locus|lexicon|ashlr-md|ashlr-stack) ;; *) echo "RESULT ABORT repo-not-allowlisted"; exit 1;; esac
REPO="ashlrai/$NAME"; FORK_URL="https://github.com/masonwyatt23/$NAME.git"
CMN=$(cd -P -- "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P); EXP=$(cd -P -- "$HOME/Projects/ashlrai/$NAME/.git" 2>/dev/null && pwd -P)
[ -n "$CMN" ] && [ "$CMN" = "$EXP" ] || { echo "RESULT ABORT repo-mismatch"; exit 1; }
# Explicit operator-only mode for reconciling an already-integrated ORIGINAL PR.
# No new delta is accepted: the authored two-parent merge must equal pinned main.
# Both proof checks run through the same pinned Git helper and literal GitHub repos.
if [ "$IM" = 1 ]; then
  IMHELP="$R/bin/integrated-merge.py"; IMHELP_SHA=804929cb30a12555b809fbfcfa8e8133bfc23a8fdcd67341c4cbc1c14de818c2
  [ -f "$IMHELP" ] && [ ! -L "$IMHELP" ] && [ "$(/usr/bin/shasum -a 256 "$IMHELP" | awk '{print $1}')" = "$IMHELP_SHA" ] || { echo "RESULT ABORT integrated-helper-pin"; exit 1; }
  if [ "$IU" = 0 ]; then
    IMLOCK="$R/integrated-merge/$J.publish-lock"
    mkdir "$IMLOCK" 2>/dev/null || { IMLOCK=""; echo "RESULT HOLD integrated-publisher-owned"; exit 1; }
  fi
  im_verify(){ /usr/bin/python3 -I -B "$IMHELP" --job "$J" --base "$BASE" --worktree "$WT" $( [ "$IU" = 1 ] && printf %s "--upstream-feature --prepare" ); }
  IMPROOF=$(im_verify) || { echo "RESULT ABORT integrated-proof"; exit 1; }
  read IMPR IMMAIN IMOLD IMSHA IMTREE IMEXTRA <<< "$IMPROOF"
  [[ "$IMPR" =~ ^[0-9]+$ ]] && [ "$BASE" = "$IMMAIN" ] && [[ "$IMOLD$IMSHA$IMTREE" =~ ^[0-9a-f]{120}$ ]] && [ -z "$IMEXTRA" ] || { echo "RESULT ABORT integrated-proof-shape"; exit 1; }
  echo "NOTE verified original PR $IMPR already integrated; preserve reviewed merge $IMSHA"
fi
# This closed profile exits before the legacy classifier's index staging,
# worktree cleanup, reset, or commit. A tuple-wide durable marker is a one-shot
# fence even when the push result or the process itself is lost.
if [ "$IU" = 1 ]; then
  verify_dependency_links || { echo "RESULT ABORT dependency-directory-link-or-index-unavailable"; exit 1; }
  git diff --no-ext-diff --no-textconv "$BASE"...HEAD | perl "$R/bin/scrub.pl" --check --allow-fixtures >/dev/null || { echo "RESULT ABORT secret-shape"; exit 1; }
  if [ -f BRIDGE_NOTES.md ]; then
    perl "$R/bin/scrub.pl" --check < BRIDGE_NOTES.md >/dev/null || { echo "RESULT ABORT secret-shape-notes"; exit 1; }
  fi
  [ "$(im_verify)" = "$IMPROOF" ] || { echo "RESULT ABORT integrated-proof-changed"; exit 1; }
  GSWHY=$(gs_check "$WT") || { echo "RESULT ABORT git-unsafe $GSWHY"; exit 1; }
  im_phase(){ /usr/bin/python3 -I -B "$IMHELP" --job "$J" --base "$BASE" --worktree "$WT" --upstream-feature "$@"; }
  ATTEMPT=$(im_phase --attempt) || { echo "RESULT HOLD upstream-attempt-unsafe"; exit 1; }
  read ATTEMPT_KIND ATTEMPT_TOKEN ATTEMPT_EXTRA <<< "$ATTEMPT"
  case "$ATTEMPT_KIND" in
    CREATED) [[ "$ATTEMPT_TOKEN" =~ ^[0-9a-f]{64}$ ]] && [ -z "$ATTEMPT_EXTRA" ] || { echo "RESULT HOLD upstream-attempt-invalid"; exit 1; }; im_phase --push --token "$ATTEMPT_TOKEN" || echo "NOTE upstream push uncertain; reconciling"; unset ATTEMPT_TOKEN ATTEMPT ;;
    EXISTING) [ -z "$ATTEMPT_TOKEN$ATTEMPT_EXTRA" ] || { echo "RESULT HOLD upstream-attempt-invalid"; exit 1; }; echo "NOTE prior upstream attempt; reconciling without retry" ;;
    *) echo "RESULT HOLD upstream-attempt-invalid"; exit 1 ;;
  esac
  record_outcome(){ im_phase --record-outcome "$1" >/dev/null; }
  OUTCOME=$(im_phase --outcome) || OUTCOME=HELD
  case "$OUTCOME" in
    MERGED|QUEUED) record_outcome "$OUTCOME" || { echo "RESULT HOLD upstream-journal-error"; exit 1; }; echo "RESULT $OUTCOME original157"; exit 0 ;;
    REQUESTED) record_outcome "$OUTCOME" || { echo "RESULT HOLD upstream-journal-error"; exit 1; }; echo "RESULT HOLD upstream-auto-requested"; exit 1 ;;
    READY) ;;
    HELD) record_outcome HELD || :; echo "RESULT HOLD upstream-outcome-unknown"; exit 1 ;;
    *) echo "RESULT HOLD upstream-outcome-invalid"; exit 1 ;;
  esac
  [ "$(im_phase --admission)" = "$IMPROOF" ] || { record_outcome HELD || :; echo "RESULT HOLD upstream-admission-unproven"; exit 1; }
  # Server-enforced protected merge only; a request is not a merge. A timeout
  # is reconciled by fresh independent observations, never retried as a push.
  IMMETHOD=--merge
  case "$REPO:$IMPR" in ashlrai/lexicon:479|ashlrai/lexicon:480) IMMETHOD=--squash;; esac
  perl -e 'alarm shift; exec @ARGV' 30 gh pr merge "https://github.com/$REPO/pull/$IMPR" --repo "$REPO" "$IMMETHOD" --auto --match-head-commit "$IMSHA" || echo "NOTE upstream merge request uncertain; reconciling"
  OUTCOME=$(im_phase --outcome) || OUTCOME=HELD
  case "$OUTCOME" in MERGED|QUEUED|REQUESTED|HELD) ;; *) OUTCOME=HELD ;; esac
  record_outcome "$OUTCOME" || { echo "RESULT HOLD upstream-journal-error"; exit 1; }
  case "$OUTCOME" in
    MERGED|QUEUED) echo "RESULT $OUTCOME original157" ;;
    REQUESTED) echo "RESULT HOLD upstream-auto-requested"; exit 1 ;;
    *) echo "RESULT HOLD upstream-merge-unconfirmed"; exit 1 ;;
  esac
  exit 0
fi
# >>> G1CLASSIFY (GATES v4, Mason Nov 4 2026; PUBLISH-CLASSIFIER rev1c): .github/ and release*.yml need a G1 pass ONLY for
# category-3 triggers: a new secrets reference (secrets.X, secrets[...], secrets: inherit), id-token other than none/read
# (write-all included, it grants id-token), a pull_request_target or workflow_run trigger, a uses: not pinned to a 40-hex
# sha / docker sha256 / local path. Trigger tokens matched by shape (not substring), so .workflow_run.id is allowed.
# Fail-closed evasion guards under .github/workflows and .github/actions: YAML alias in an on: line, \\x/\\u escape
# inside a quoted key, binary or symlink content, a typechange. Other writes (contents, packages, pull-requests, ...) and removed permissions or triggers AUTO-PASS
# and are logged to $R/g1-async-review.log for async Tier-1 review. Diff is read from a temp file (no pipe, so an early
# classifier exit cannot SIGPIPE the producer); any classifier error or missing end marker fails closed.
IFS= read -r -d '' G1PL <<'PL' || :
my($f,$h,$r)=("",0,""); my %a;
while(<STDIN>){chomp;
 if(/^diff --git a\/.* b\/(.*)$/){$f=$1;$h=1;next}
 my $ex = ($f =~ m{^\.github/(workflows|actions)/});
 if(/^Binary files /||/^GIT binary patch/){ if($ex){$r="binary";last} next }
 if($h){ if(/^@@/){$h=0;next} if($ex && /mode 120000/){$r="symlink";last} next }
 next if /^@@/ || /^\\/;
 my $wf = ($f =~ m{^\.github/workflows/});
 if(s/^\+//){ s/^\s*#.*$//; s/\s+#.*$//; next unless /\S/;
  if(/id-token/i && !/id-token["']?\s*:\s*["']?(none|read)\b/i){$r="id-token";last}
  if(/write-all/i){$r="id-token";last}
  if(/secrets\s*[.\[)]/i || /\bsecrets["']?\s*:\s*["']?inherit\b/i || /\bsecrets\b\s*\)/i){$r="secrets";last}
  if(/(?<![.\w-])["\']?(?:pull_request_target|workflow_run)["\']?(?=\s*(?::|,|\]|\}|$))/i){$r="trigger";last}
  if(/^\s*-?\s*\{?\s*["']?uses["']?\s*:\s*["']?([^"'\s,}]+)/i){my $u=$1;
   unless($u=~m{^\./} || $u=~m{^docker://\S+\@sha256:[0-9a-f]{64}$}i || $u=~m{\@[0-9a-f]{40}$}i){$r="unpinned-action";last}}
  if(/\buses\b/i && !/^\s*-?\s*\{?\s*["']?uses["']?\s*:/i && /\buses["']?\s*:/i){$r="unpinned-action";last}
  if($wf && /^\s*["']?(on|true)["']?\s*:.*(\*|&|<<)/){$r="trigger-key-unclassified";last}
  if($ex && /["'][^"']*\\[xu][0-9a-fA-F]+[^"']*["']\s*:/){$r="trigger-key-unclassified";last}
  if(/:\s*["']?write\b/i || /^\s*-?\s*["']?permissions["']?\s*:/i){$a{"$f permissions-added-or-widened"}=1}
 } elsif(s/^-//){
  if($wf && (/^\s*-?\s*["']?permissions["']?\s*:/i || /^\s*["']?(on|true)["']?\s*:/ || /^\s*[a-z_-]+\s*:\s*["']?(read|none)\b/i)){$a{"$f perm-or-trigger-removed"}=1}
 }
}
if($r eq ""){ print "ASYNC $_\n" for sort keys %a; }
print "G1END:$r\n";
PL
G1PS1=':(glob).github/**'; G1PS2=':(glob)**/release*.yml'; G1PS3=':(glob)**/release*.yaml'
g1d(){ git diff --no-ext-diff --no-textconv --no-color --no-renames "$@" "$BASE" -- "$G1PS1" "$G1PS2" "$G1PS3"; }
for ps in "$G1PS1" "$G1PS2" "$G1PS3"; do git add -N -- "$ps" >/dev/null 2>&1 || :; done
G1R=""; G1OK=0; G1AS=""; G1TF=$(mktemp "${TMPDIR:-/tmp}/g1d.XXXXXX") || { echo "RESULT ABORT g1-tmp"; exit 1; }
if G1NS=$(g1d --name-status) && g1d -U0 > "$G1TF"; then
  G1R=$(awk -F'\t' '$1 ~ /^T/ { for(i=2;i<=NF;i++) if ($i ~ /^\.github\/workflows\//) { print "workflow-typechanged"; exit } }' <<< "$G1NS")  # rev1b: typechange only; adds/renames are classified by content
  if [ -z "$G1R" ]; then
    if G1O=$(perl -e "$G1PL" < "$G1TF") && [ "$(tail -n1 <<< "$G1O" | cut -c1-6)" = "G1END:" ]; then
      G1R=$(tail -n1 <<< "$G1O" | cut -c7-); G1AS=$(grep '^ASYNC ' <<< "$G1O" | cut -c7-)
    else G1R="classifier-failed"; fi
  fi
else G1R="diff-unavailable"; fi
rm -f "$G1TF"
[ -z "$G1R" ] && [ -n "$G1AS" ] && { echo "NOTE G1 async-review: $(echo $G1AS)"; while IFS= read -r l; do echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $J $NAME $l"; done <<< "$G1AS" >> "$R/g1-async-review.log"; }
# <<< G1CLASSIFY
# G1 mode (Masbot, Oct 26): .github/ and release*.yml publish only with a one-shot pass $R/g1-pass/$J.pass = "<job> <tree40> <parent40>",
# written only by Masbot from a Security PASS pinned to that tree (all *.sb profiles deny ~/.ashlr-runs, so jobs cannot write it); consumed after one push.
G1F="$R/g1-pass/$J.pass"; G1T=""; G1P=""
if [ -e "$G1F" ] || [ -L "$G1F" ]; then
  { [ ! -L "$G1F" ] && [ -f "$G1F" ] && [ "$(stat -f %u "$G1F")" = "$(id -u)" ] && [ "$(stat -f %Lp "$G1F")" = 600 ] && [[ "$J" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$J" != *..* ]]; } || { echo "RESULT ABORT g1-pass-invalid"; exit 1; }
  read G1J G1T G1P G1X < "$G1F"
  { [ "$G1J" = "$J" ] && [[ "$G1T" =~ ^[0-9a-f]{40}$ ]] && [[ "$G1P" =~ ^[0-9a-f]{40}$ ]] && [ -z "$G1X" ] && [ "$G1P" = "$(git rev-parse "$BASE")" ]; } || { echo "RESULT ABORT g1-pass-invalid"; exit 1; }
  echo "NOTE G1 mode pinned tree $G1T parent $G1P"; fi
if [ -n "$G1R" ]; then echo "G1 category3=$G1R"; [ -n "$G1T" ] || { echo "RESULT ABORT g1-pass-required category3=$G1R"; exit 1; }; else echo "G1 not-required"; G1OK=1; fi
PD=".github .envrc .vscode .husky"; { [ -n "$G1T" ] || [ "$G1OK" = 1 ]; } && PD=".envrc .vscode .husky"
[ "$IM" = 1 ] || { [ "$(git rev-parse HEAD)" = "$BASE" ] || git reset --soft "$BASE"; }
NOTES=""; [ -f BRIDGE_NOTES.md ] && { NOTES=$(cat BRIDGE_NOTES.md); mv BRIDGE_NOTES.md $R/$J.notes.md; }
GD=$(git status --porcelain -uall -- $PD | cut -c4-); [ -n "$GD" ] && { echo "NOTE PROTECTED_DRIFT reverted: $(echo $GD)"; for d in $PD; do git checkout "$BASE" -- $d 2>/dev/null; git clean -fdq -- $d; done; echo "$GD" | grep -q "^\.github/workflows" && { echo "RESULT ABORT workflow-drift"; exit 1; }; }
git add -A
verify_dependency_links || { echo "RESULT ABORT dependency-directory-link-or-index-unavailable"; exit 1; }
FILES=$(git diff --cached --name-only "$BASE"); [ -z "$FILES" ] && [ "$IM" = 0 ] && { echo "RESULT EMPTY"; exit 0; }
[ "$IM" = 0 ] || [ -z "$FILES" ] || { echo "RESULT ABORT integrated-unreviewed-delta"; exit 1; }
SKIP=$(git ls-files -v | grep -c '^S')
CO=$(for p in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS; do git show "$BASE:$p" 2>/dev/null; done | grep -v '^\s*#' | awk 'NF{print $1}')
DENY=0; T1=""
while IFS= read -r f; do
  # PUBLISH-CLASSIFIER rev1c (GATES v4 hard limits only): .npmrc can carry registry auth or redirect publishes (secrets).
  # .github and release*.yml are cleared by G1CLASSIFY above; CODEOWNERS and .releaserc denies cut (not a hard limit).
  d=0; [[ "$f" =~ (^|/)\.npmrc$ ]] && d=1
  # Security gate-classes 02:40: CODEOWNERS/Tier-1 source is DROP at merge (gate at release tag + async review); only .github/release/npmrc stay denied here, G1-G4 handled by SENS
  t=0; for p in $CO; do q=${p#/}; [ "$q" = "*" ] && break
    if [[ "$q" == */ ]]; then [[ "$f" == $q* ]] && t=1; else [[ "$f" == $q || "$f" == $q/* || "$f" == */$q ]] && t=1; fi; done
  [ $t = 1 ] && T1="$T1 $f"
  [ $d = 1 ] && { echo "DENIED $f"; DENY=$((DENY+1)); }
done <<< "$FILES"
[ "$SKIP" != 0 ] && echo "NOTE skip-worktree entries: $SKIP (not committed, not a gate)"
[ $DENY -gt 0 ] && { echo "RESULT DENIED Denied paths: $DENY"; exit 0; }
# GATES v4 hard-limit pins (rev1b: plists, lock scripts and prompts cut): auto-merge is skipped only for these pinned paths and for category-3 workflow diffs
SRE='(^|/)(scrub\.pl|publish\.sh|git-safe-env\.sh|mac-live-pins\.md|pin-clearance\.json)$|secret-shape|(^|/)[^/]*\.sb$|(^|/)\.codex(/|$)|(^|/)\.claude/settings[^/]*\.json$|(^|/)bin/[^/]*(leader|wrapper)[^/]*$'
SENS=$(echo "$FILES" | grep -E "$SRE" | tr '\n' ' ')
[ -n "$G1R" ] && SENS="$SENS G1-category3:$G1R"
[ -n "$G1T" ] && SENS="$SENS G1-pass:$G1T"
TH=$(mktemp -d); export RUSTUP_HOME=${RUSTUP_HOME:-$HOME/.rustup} CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}
if [ -f Cargo.toml ]; then TC="cargo test --quiet"; elif [ -f package.json ] && grep -q '"test"' package.json; then TC="npm test --silent"; else TC=""; fi
[ "${PUBLISH_FULL_TESTS:-0}" = 1 ] || TC=""  # full suite was informational only (~19 min/job); agents run touched tests, required CI checks gate merge
TR="no test command"; if [ -n "$TC" ]; then
  RH=$HOME; NPMC=$(npm config get cache 2>/dev/null || echo $RH/.npm)
  if [ -f package.json ] && [ ! -d node_modules ]; then
    if [ -f pnpm-lock.yaml ]; then pnpm i --frozen-lockfile; elif [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile || bun install; elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci --cache "$NPMC" --no-audit --no-fund; else npm i --cache "$NPMC" --no-audit --no-fund --no-save; fi 2>&1 | $SCRUB >> $R/$J.install.log; fi
  HOME=$TH npm_config_cache=$NPMC CARGO_HOME=$CARGO_HOME RUSTUP_HOME=$RUSTUP_HOME PATH=$PWD/node_modules/.bin:$CARGO_HOME/bin:$PATH perl -e 'alarm shift; exec @ARGV' 1500 $TC 2>&1 | $SCRUB > $R/$J.test.log; rc=$?
  TR="\`$TC\` (temp HOME) exit $rc; tail: $(tail -5 $R/$J.test.log | tr '\n' ' ' | cut -c1-400)"; fi
echo "TEST $TR"
if [ "$IM" = 0 ]; then
  git -c core.hooksPath=/dev/null ${GUN:+-c "user.name=$GUN"} ${GUE:+-c "user.email=$GUE"} commit -q --no-verify -m "bridge($J): $(echo "$NOTES" | grep -m1 -v '^\s*$' | sed 's/^#* *//' | cut -c1-60)" || { echo "RESULT ABORT commit"; exit 1; }
  SHA=$(git rev-parse HEAD); [ "$(git rev-list --parents -n1 $SHA | awk '{print NF-1, $2}')" = "1 $BASE" ] || { echo "RESULT ABORT parent"; exit 1; }
else
  SHA=$(git rev-parse HEAD)
  [ "$SHA" = "$IMSHA" ] || { echo "RESULT ABORT integrated-head-changed"; exit 1; }
fi
[ -n "$G1T" ] && { [ "$(git rev-parse HEAD^{tree})" = "$G1T" ] && [ "$(git rev-parse HEAD^)" = "$G1P" ] && [ "$(git rev-list --count "$G1P..HEAD")" = 1 ] || { git reset -q --soft "$BASE"; echo "RESULT ABORT g1-tree-mismatch"; exit 1; }; }
# Integrated mode has already proved the original fork exists; never bootstrap one.
if [ "$IM" = 0 ]; then
  gh repo view masonwyatt23/$NAME >/dev/null 2>&1 || gh repo fork $REPO --clone=false >/dev/null 2>&1; sleep 2
fi
# FORKGUARD (Security, Nov 2): the push target must be a real fork, not a rename/transfer redirect to upstream. Exact,
# case-sensitive full_name, fork true, parent ashlrai/$NAME; any API error or timeout fails closed before push.
fg_check(){ local o; o=$(perl -e 'alarm shift; exec @ARGV' 30 gh api "repos/masonwyatt23/$1" --jq '[.full_name,.fork,.parent.full_name]' 2>/dev/null) || return 1
  [ "$o" = "[\"masonwyatt23/$1\",true,\"ashlrai/$1\"]" ]; }
[ "$IU" = 1 ] || fg_check "$NAME" || { echo "RESULT ABORT fork-target-invalid"; exit 1; }
git diff --no-ext-diff --no-textconv "$BASE"...HEAD | perl "$R/bin/scrub.pl" --check --allow-fixtures >/dev/null || { echo "RESULT ABORT PUBLISH-ABORT secret-shape in diff ($J)"; exit 1; }
printf '%s\n' "$NOTES" | perl "$R/bin/scrub.pl" --check >/dev/null || { echo "RESULT ABORT PUBLISH-ABORT secret-shape in notes ($J)"; exit 1; }
# Recheck original PR/ref/head and exact current main immediately before any push.
[ "$IM" = 0 ] || { [ "$(im_verify)" = "$IMPROOF" ] || { echo "RESULT ABORT integrated-proof-changed"; exit 1; }; }
# push (rev2, Masbot): never loads ~/.gitconfig (helper env: GIT_CONFIG_GLOBAL=/dev/null, no system config). Credential is pinned here:
# reset any helper, then gh's git-credential for https://github.com only. gs_check's credential.* refusal covers config FILES, not these fixed -c.
# rev4: empty http.extraHeader resets the multi-valued list, but only for the unscoped key; url-scoped
# http.<url>.* outranks it, so the github.com-scoped keys are reset too (verified on git 2.47.3, see NOTES).
git -c core.hooksPath=/dev/null -c credential.helper= -c 'credential.https://github.com.helper=!/opt/homebrew/bin/gh auth git-credential' \
  -c http.sslVerify=true -c http.proxy= -c http.extraHeader= \
  -c http.https://github.com/.sslVerify=true -c http.https://github.com/.proxy= -c http.https://github.com/.extraHeader= \
  push -q --no-verify "$FORK_URL" $SHA:refs/heads/codex-bridge/$J || { echo "RESULT ABORT push"; exit 1; }
[ -n "$G1T" ] && { rm -f "$G1F"; echo "NOTE G1 pass consumed"; }
if [ "$IM" = 1 ]; then
  mv "$R/integrated-merge/$J.json" "$R/integrated-merge/$J.$IMSHA.consumed" || { echo "RESULT ABORT integrated-receipt-consume"; exit 1; }
fi
DEF=$(gh repo view $REPO --json defaultBranchRef -q .defaultBranchRef.name)
PUBLISH_CONTEXT="single commit on base \`${BASE:0:9}\`"
[ "$IM" = 0 ] || PUBLISH_CONTEXT="reviewed original-PR merge \`${IMSHA:0:9}\`, tree equal to current main \`${BASE:0:9}\`"
{ echo "Automated bridge job \`$J\` (pool: $POOL), $PUBLISH_CONTEXT."; echo; echo "**Tests:** $TR"; echo; [ -n "$SENS" ] && echo "**Sensitive paths (needs Security OK):** $SENS" && echo; [ -n "$T1" ] && echo "**Tier-1 (CODEOWNERS) paths, async post-merge review:**$T1" && echo; echo "<details><summary>Agent notes</summary>"; echo; echo "$NOTES"; echo "</details>"; } > $R/$J.body.md
case "$J" in LAND*) SUP=$(grep -ohE "https://github.com/$REPO/pull/[0-9]+" $R/$J.prompt 2>/dev/null | head -1); [ -n "$SUP" ] && printf "\n\nSupersedes %s\n" "$SUP" >> $R/$J.body.md && echo "NOTE supersedes $SUP";; esac
if [ "$IM" = 1 ]; then
  URL="https://github.com/$REPO/pull/$IMPR"
else
  URL=$(gh pr create --repo $REPO --head masonwyatt23:codex-bridge/$J --base $DEF --title "bridge: $J" --body-file $R/$J.body.md) || { echo "RESULT ABORT pr"; exit 1; }
fi
: # opened ready directly; draft->ready double-triggered CI and cancelled runs showed as failures
# RQ-SWE5-FRESH-JUDGE (digest item 2): with PUBLISH_JUDGE_CMD set, a fresh-context judge sees only diff + done-contract (job prompt) + test
# evidence, never $NOTES. Anything but a confident pass leaves auto-merge unarmed for leader review. Unset = gate off.
JUDGE_OK=1
if [ -n "${PUBLISH_JUDGE_CMD:-}" ] && [ -z "$SENS" ] && [ -z "$G1T" ]; then
  git diff --no-ext-diff --no-textconv "$BASE"...HEAD > $R/$J.judge.diff; printf '%s\n' "$TR" > $R/$J.judge.evidence
  [ ! -f $R/$J.test.log ] || $SCRUB < $R/$J.test.log | tail -200 >> $R/$J.judge.evidence
  JV=$(python3 -I -B "$R/bin/judge_gate.py" --diff $R/$J.judge.diff --contract $R/$J.prompt --evidence $R/$J.judge.evidence) || JUDGE_OK=0
  echo "$JV"; rm -f $R/$J.judge.diff $R/$J.judge.evidence
fi
if [ $JUDGE_OK = 0 ]; then echo "NOTE AUTO_MERGE skipped judge (leader review)"
elif [ -z "$SENS" ] && [ -z "$G1T" ]; then
  if ME=$(gh pr merge "$URL" --repo $REPO --auto 2>&1 >/dev/null); then echo "AUTO_MERGE on"
  elif printf '%s' "$ME" | grep -qiE 'merge method|not allowed|required when not running interactively' && gh pr merge "$URL" --repo $REPO --auto --squash >/dev/null 2>&1; then echo "AUTO_MERGE on (squash fallback)"
  else echo "NOTE AUTO_MERGE skipped-or-failed"; fi
else echo "NOTE AUTO_MERGE skipped sensitive"; fi
echo "RESULT PR $URL SENS=[$SENS]"
