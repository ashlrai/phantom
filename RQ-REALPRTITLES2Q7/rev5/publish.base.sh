#!/bin/bash
# usage: publish.sh <job-id>  -> writes ~/.ashlr-runs/<job>.publish
J=$1; R=~/.ashlr-runs; OUT=$R/$J.publish; exec >"$OUT" 2>&1; set -o pipefail
# RQ-SEC-RUNLOG-SCRUB: scrub this run log on exit; install/test logs are piped through scrub.pl
SCRUB="perl $R/bin/scrub.pl"; trap '$SCRUB < "$OUT" > "$OUT.s" && mv "$OUT.s" "$OUT"' EXIT
read BASE BR WT POOL < $R/$J.base
[ -z "$BASE" ] && { echo "RESULT ABORT empty-base"; exit 1; }
cd "$WT" || { echo "RESULT ABORT no-wt"; exit 1; }
# RQ-GIT-SAFE (NEEDS MASON'S OK): every git call below goes through the pinned helper after gs_check of the worktree
# (gitlink/commondir verified, no filter/textconv/fsmonitor/hooks/include config, no filter= attributes, GIT_* env scrubbed).
GS="$R/bin/git-safe-env.sh"; GS_SHA=7ecf153b007bf8254bb31ac51be9c1d4774178540d5cb1e93b1afc925453b544   # GIT-SAFE rev4.1
{ [ -f "$GS" ] && [ ! -L "$GS" ] && [ "$( { /usr/bin/shasum -a 256 "$GS" 2>/dev/null || sha256sum "$GS" 2>/dev/null; } | awk 'NR==1{print $1}')" = "$GS_SHA" ] && . "$GS" && gs_init; } || { echo "RESULT ABORT git-safe-unavailable"; exit 1; }
GSWHY=$(gs_check "$WT") || { echo "RESULT ABORT git-unsafe $GSWHY"; exit 1; }
git(){ gs_git "$WT" "$@"; }
# commit identity: read (runs nothing, no includes) from the user's ~/.gitconfig as a plain file, passed explicitly as -c; global config is otherwise off
GUN=$("$GS_GIT" config --file "$HOME/.gitconfig" --get user.name 2>/dev/null); GUE=$("$GS_GIT" config --file "$HOME/.gitconfig" --get user.email 2>/dev/null)
# rev3 P1: NAME and REPO come only from dispatchd's own job record ($R/queue/run/<J>.line, the ready.tsv line:
# J<TAB>repo<TAB>lane<TAB>tier...), never from git config or an origin url. NAME must be on the 7-repo allowlist and the
# worktree's common dir must be exactly ~/Projects/ashlrai/$NAME/.git. Push goes to a literal URL, never a remote name.
[[ "$J" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$J" != *..* ]] || { echo "RESULT ABORT bad-job-id"; exit 1; }
JL="$R/queue/run/$J.line"; [ -f "$JL" ] && [ ! -L "$JL" ] || { echo "RESULT ABORT no-job-record"; exit 1; }
IFS=$'\t' read -r LJ NAME LX < "$JL"
[ "$LJ" = "$J" ] || { echo "RESULT ABORT job-record-mismatch"; exit 1; }
case "$NAME" in phantom|phantom-secrets|ashlr-plugin|locus|lexicon|ashlr-md|ashlr-stack) ;; *) echo "RESULT ABORT repo-not-allowlisted"; exit 1;; esac
REPO="ashlrai/$NAME"; FORK_URL="https://github.com/masonwyatt23/$NAME.git"
CMN=$(cd -P -- "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P); EXP=$(cd -P -- "$HOME/Projects/ashlrai/$NAME/.git" 2>/dev/null && pwd -P)
[ -n "$CMN" ] && [ "$CMN" = "$EXP" ] || { echo "RESULT ABORT repo-mismatch"; exit 1; }
# G1 mode (Masbot, Oct 26): .github/ and release*.yml publish only with a one-shot pass $R/g1-pass/$J.pass = "<job> <tree40> <parent40>",
# written only by Masbot from a Security PASS pinned to that tree (all *.sb profiles deny ~/.ashlr-runs, so jobs cannot write it); consumed after one push.
G1F="$R/g1-pass/$J.pass"; G1T=""; G1P=""
if [ -e "$G1F" ] || [ -L "$G1F" ]; then
  { [ ! -L "$G1F" ] && [ -f "$G1F" ] && [ "$(stat -f %u "$G1F")" = "$(id -u)" ] && [ "$(stat -f %Lp "$G1F")" = 600 ] && [[ "$J" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$J" != *..* ]]; } || { echo "RESULT ABORT g1-pass-invalid"; exit 1; }
  read G1J G1T G1P G1X < "$G1F"
  { [ "$G1J" = "$J" ] && [[ "$G1T" =~ ^[0-9a-f]{40}$ ]] && [[ "$G1P" =~ ^[0-9a-f]{40}$ ]] && [ -z "$G1X" ] && [ "$G1P" = "$(git rev-parse "$BASE")" ]; } || { echo "RESULT ABORT g1-pass-invalid"; exit 1; }
  echo "NOTE G1 mode pinned tree $G1T parent $G1P"; fi
PD=".github .envrc .vscode .husky"; [ -n "$G1T" ] && PD=".envrc .vscode .husky"
[ "$(git rev-parse HEAD)" != "$BASE" ] && git reset --soft "$BASE"
NOTES=""; [ -f BRIDGE_NOTES.md ] && { NOTES=$(cat BRIDGE_NOTES.md); mv BRIDGE_NOTES.md $R/$J.notes.md; }
GD=$(git status --porcelain -uall -- $PD | cut -c4-); [ -n "$GD" ] && { echo "NOTE PROTECTED_DRIFT reverted: $(echo $GD)"; for d in $PD; do git checkout "$BASE" -- $d 2>/dev/null; git clean -fdq -- $d; done; echo "$GD" | grep -q "^\.github/workflows" && { echo "RESULT ABORT workflow-drift"; exit 1; }; }
git add -A
FILES=$(git diff --cached --name-only "$BASE"); [ -z "$FILES" ] && { echo "RESULT EMPTY"; exit 0; }
SKIP=$(git ls-files -v | grep -c '^S')
CO=$(for p in .github/CODEOWNERS CODEOWNERS docs/CODEOWNERS; do git show "$BASE:$p" 2>/dev/null; done | grep -v '^\s*#' | awk 'NF{print $1}')
DENY=0; T1=""
while IFS= read -r f; do
  d=0; [[ "$f" =~ ^\.github/|CODEOWNERS|\.releaserc|(^|/)release[^/]*\.ya?ml$|(^|/)\.npmrc$ ]] && d=1
  # Security gate-classes 02:40: CODEOWNERS/Tier-1 source is DROP at merge (gate at release tag + async review); only .github/release/npmrc stay denied here, G1-G4 handled by SENS
  t=0; for p in $CO; do q=${p#/}; [ "$q" = "*" ] && break
    if [[ "$q" == */ ]]; then [[ "$f" == $q* ]] && t=1; else [[ "$f" == $q || "$f" == $q/* || "$f" == */$q ]] && t=1; fi; done
  [ $t = 1 ] && T1="$T1 $f"
  [ -n "$G1T" ] && [[ "$f" =~ ^\.github/|^release[^/]*\.ya?ml$ ]] && [[ ! "$f" =~ (^|/)\.npmrc$|\.releaserc ]] && d=0
  [ $d = 1 ] && { echo "DENIED $f"; DENY=$((DENY+1)); }
done <<< "$FILES"
[ "$SKIP" != 0 ] && { echo "skip-worktree entries: $SKIP"; DENY=$((DENY+SKIP)); }
[ $DENY -gt 0 ] && { echo "RESULT DENIED Denied paths: $DENY"; exit 0; }
# Security gate-classes verdict 02:40: G1 workflows (all repos); G2 ashlr-plugin manifests/locks; G3 ashlr-stack manifests/locks; G4 ashlr-plugin server/
case "$NAME" in ashlr-plugin) SRE='^\.github/workflows/|^(server/|site/)?(package\.json|bun\.lockb?)$|^server/';; ashlr-stack) SRE='^\.github/workflows/|^(package\.json|bun\.lockb?|packages/site/package\.json)$';; *) SRE='^\.github/workflows/';; esac
SENS=$(echo "$FILES" | grep -E "$SRE" | tr '\n' ' ')
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
git -c core.hooksPath=/dev/null ${GUN:+-c "user.name=$GUN"} ${GUE:+-c "user.email=$GUE"} commit -q --no-verify -m "bridge($J): $(echo "$NOTES" | grep -m1 -v '^\s*$' | sed 's/^#* *//' | cut -c1-60)" || { echo "RESULT ABORT commit"; exit 1; }
SHA=$(git rev-parse HEAD); [ "$(git rev-list --parents -n1 $SHA | awk '{print NF-1, $2}')" = "1 $BASE" ] || { echo "RESULT ABORT parent"; exit 1; }
[ -n "$G1T" ] && { [ "$(git rev-parse HEAD^{tree})" = "$G1T" ] && [ "$(git rev-parse HEAD^)" = "$G1P" ] && [ "$(git rev-list --count "$G1P..HEAD")" = 1 ] || { git reset -q --soft "$BASE"; echo "RESULT ABORT g1-tree-mismatch"; exit 1; }; }
gh repo view masonwyatt23/$NAME >/dev/null 2>&1 || gh repo fork $REPO --clone=false >/dev/null 2>&1; sleep 2
git diff --no-ext-diff --no-textconv "$BASE"...HEAD | perl "$R/bin/scrub.pl" --check --allow-fixtures >/dev/null || { echo "RESULT ABORT PUBLISH-ABORT secret-shape in diff ($J)"; exit 1; }
printf '%s\n' "$NOTES" | perl "$R/bin/scrub.pl" --check >/dev/null || { echo "RESULT ABORT PUBLISH-ABORT secret-shape in notes ($J)"; exit 1; }
# push (rev2, Masbot): never loads ~/.gitconfig (helper env: GIT_CONFIG_GLOBAL=/dev/null, no system config). Credential is pinned here:
# reset any helper, then gh's git-credential for https://github.com only. gs_check's credential.* refusal covers config FILES, not these fixed -c.
# rev4: empty http.extraHeader resets the multi-valued list, but only for the unscoped key; url-scoped
# http.<url>.* outranks it, so the github.com-scoped keys are reset too (verified on git 2.47.3, see NOTES).
git -c core.hooksPath=/dev/null -c credential.helper= -c 'credential.https://github.com.helper=!/opt/homebrew/bin/gh auth git-credential' \
  -c http.sslVerify=true -c http.proxy= -c http.extraHeader= \
  -c http.https://github.com/.sslVerify=true -c http.https://github.com/.proxy= -c http.https://github.com/.extraHeader= \
  push -q --no-verify "$FORK_URL" $SHA:refs/heads/codex-bridge/$J || { echo "RESULT ABORT push"; exit 1; }
[ -n "$G1T" ] && { rm -f "$G1F"; echo "NOTE G1 pass consumed"; }
DEF=$(gh repo view $REPO --json defaultBranchRef -q .defaultBranchRef.name)
{ echo "Automated bridge job \`$J\` (pool: $POOL), single commit on base \`${BASE:0:9}\`."; echo; echo "**Tests:** $TR"; echo; [ -n "$SENS" ] && echo "**Sensitive paths (needs Security OK):** $SENS" && echo; [ -n "$T1" ] && echo "**Tier-1 (CODEOWNERS) paths, async post-merge review:**$T1" && echo; echo "<details><summary>Agent notes</summary>"; echo; echo "$NOTES"; echo "</details>"; } > $R/$J.body.md
case "$J" in LAND*) SUP=$(grep -ohE "https://github.com/$REPO/pull/[0-9]+" $R/$J.prompt 2>/dev/null | head -1); [ -n "$SUP" ] && printf "\n\nSupersedes %s\n" "$SUP" >> $R/$J.body.md && echo "NOTE supersedes $SUP";; esac
URL=$(gh pr create --repo $REPO --head masonwyatt23:codex-bridge/$J --base $DEF --title "bridge: $J" --body-file $R/$J.body.md) || { echo "RESULT ABORT pr"; exit 1; }
: # opened ready directly; draft->ready double-triggered CI and cancelled runs showed as failures
[ -z "$SENS" ] && [ -z "$G1T" ] && { gh pr merge "$URL" --repo $REPO --auto --squash >/dev/null 2>&1 || gh pr merge "$URL" --repo $REPO --auto >/dev/null 2>&1; } && echo "AUTO_MERGE on" || echo "NOTE AUTO_MERGE skipped-or-failed"
echo "RESULT PR $URL SENS=[$SENS]"
