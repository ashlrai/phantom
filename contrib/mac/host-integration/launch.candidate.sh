#!/bin/bash
# launch.sh <job> <repo> <pool> [tier: frontier|work|mid|fast] ; prompt body on stdin
# GATES v4: sandbox profile shas come from the pinned table bin/sandbox-pins.tsv (written only by bin/sb-autopin.py or a Security pin;
# write-denied to every lane and the leader). An absent entry yields an empty sha, so the check below refuses.
pinsha(){ /usr/bin/awk -F'\t' -v n="$1" '$1==n{print $2}' "$HOME/.ashlr-runs/bin/sandbox-pins.tsv" 2>/dev/null; }
# Masbot 03:25: agent stdio is piped through cat because the sandbox denies ~/.ashlr-runs and node aborts at init on a stdio fd there; git steps hold a per-repo lock; an existing worktree for the job is reused
unset NODE_OPTIONS NODE_PATH OPENSSL_CONF ELECTRON_RUN_AS_NODE; export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
set -o pipefail
J=$1; REPO=$2; POOL=$3; TIER=${4:-${TIER:-work}}; R=~/.ashlr-runs; RP=~/Projects/ashlrai/$REPO; WT=~/Projects/ashlrai/wt/$J
case "$TIER" in frontier|work|mid|fast) ;; *) echo "REFUSED: unknown scope tier" >&2; exit 3;; esac
~/.ashlr-runs/bin-locus-new/locus status >/dev/null 2>&1 || true   # rev1.4: WARN dropped (the pin lives in the locus-ashlr tmux session, not visible from launch; it was always false here)
# RQ-CLOSE-NOWT (Masbot 18:55 Oct 27): CLOSE-* jobs only need gh, so their worktree is index-only: --no-checkout, then
# read-tree + skip-worktree so git status/diff stay clean with no files on disk. No node_modules copy. No repo config change.
NOWT=0; NA=; case "$J" in RQ-CLOSE-*|CLOSE-*) NOWT=1; NA=--no-checkout;; esac
# RQ-FINISH-SIGNAL: each lane's background group writes the AGENT's exit status (PIPESTATUS[0], not scrub's) to $Q/run/<J>.rc, tmp then mv
rm -f "$R/queue/run/$1.rc"; rcw(){ local t="$R/queue/run/$J.rc.tmp.$BASHPID"; printf '%d\n' "$1" > "$t" 2>/dev/null && mv -f "$t" "$R/queue/run/$J.rc"; }
[ -e $R/HOLD ] && grep -qx "$POOL" $R/HOLD && { echo "HELD: launches paused (security)"; exit 3; }
[ -e $R/PAUSE ] && { echo "PAUSED: Mac low on memory, swap or disk ($(cat $R/PAUSE)); memguard clears it"; exit 4; }
# >>> existing-branch handling (Masbot P0 10:19 PM): stale codex-bridge/<job> branches blocked relaunch
# prep_branch <repo-path> <branch> : prints NEW | REUSE | DELETED_STALE | BRANCH_IN_WORKTREE <path>
# Never removes or prunes worktrees; deletes only a branch with no worktree and no unpublished commits.
prep_branch() {
  local rp=$1 br=$2 wt n
  git -C "$rp" show-ref --verify -q "refs/heads/$br" || { echo NEW; return 0; }
  wt=$(git -C "$rp" worktree list --porcelain | awk -v b="branch refs/heads/$br" '/^worktree /{w=substr($0,10)} $0==b{print w; exit}')
  [ -n "$wt" ] && { echo "BRANCH_IN_WORKTREE $wt"; return 0; }
  n=$(git -C "$rp" rev-list --count "$br" --not --remotes) || return 1
  [ "$n" -gt 0 ] && { echo REUSE; return 0; }
  git -C "$rp" branch -D -q "$br" >/dev/null || return 1
  echo DELETED_STALE
}
# <<< existing-branch handling
L=$R/.lock-$REPO; n=0; until mkdir $L 2>/dev/null; do sleep 1; n=$((n+1)); [ $n -gt 300 ] && rm -rf $L; done; trap "rmdir $L 2>/dev/null" EXIT
if [ -e $WT/.git ]; then BASE=$(git -C $WT rev-parse HEAD); echo "$BASE codex-bridge/$J $WT $POOL" > $R/$J.base; rmdir $L; else
git -C $RP fetch -q origin || exit 1; DEF=$(git -C $RP symbolic-ref -q --short refs/remotes/origin/HEAD | sed 's#origin/##'); DEF=${DEF:-main}
BASE=${BASE_OVERRIDE:-$(git -C $RP rev-parse origin/$DEF)}; [ -z "$BASE" ] && exit 1
echo "$BASE codex-bridge/$J $WT $POOL" > $R/$J.base
PB=$(prep_branch $RP codex-bridge/$J) || exit 1
case "$PB" in
  BRANCH_IN_WORKTREE*) echo "SKIPPED: BRANCH_IN_WORKTREE codex-bridge/$J is checked out at ${PB#BRANCH_IN_WORKTREE } (not relaunching)"; rm -f $R/$J.base; exit 5;;
  REUSE) echo "REUSE_BRANCH codex-bridge/$J has unpublished commits; continuing it"; git -C $RP worktree add -q $NA $WT codex-bridge/$J || exit 1
         BASE=$(git -C $WT rev-parse HEAD); echo "$BASE codex-bridge/$J $WT $POOL" > $R/$J.base;;
  *) [ "$PB" = DELETED_STALE ] && echo "DELETED_STALE_BRANCH codex-bridge/$J (no worktree, no unpublished commits)"
     git -C $RP worktree add -q $NA -b codex-bridge/$J $WT $BASE || exit 1;;
esac
rmdir $L; fi
if [ "$NOWT" = 1 ]; then [ -n "$(ls -A $WT | grep -vx .git)" ] || { git -C $WT read-tree HEAD && git -C $WT ls-files -z | xargs -0 git -C $WT update-index --skip-worktree; } || exit 1; else
[ -d $RP/node_modules ] && [ ! -e $WT/node_modules ] && cp -cR $RP/node_modules $WT/node_modules 2>/dev/null; git -C $WT ls-files -v | grep "^S" | cut -c3- | xargs -I{} git -C $WT update-index --no-skip-worktree {} 2>/dev/null
fi
{ cat
# BEGIN TIER SCOPE: keep budgets aligned with queue-tier.ts and restock.py.
SCOPE_TIER=$TIER; [ "$POOL" = codex-local ] && SCOPE_TIER=fast
case "$SCOPE_TIER" in
 frontier) SCOPE_FILES=40; SCOPE_LINES=600;;
 work) SCOPE_FILES=15; SCOPE_LINES=200;;
 mid) SCOPE_FILES=8; SCOPE_LINES=120;;
 fast) SCOPE_FILES=2; SCOPE_LINES=80;;
 *) echo "REFUSED: unknown scope tier" >&2; exit 3;;
esac
printf '\nSCOPE: up to %s files, size<=%s changed lines. Explicit narrower task limits and named-file restrictions take precedence.\n' "$SCOPE_FILES" "$SCOPE_LINES"
[ "$SCOPE_TIER" != frontier ] || printf '%s\n' 'Combine related concerns needed for the complete feature in one PR.'
printf '%s\n' 'Finish the complete feature, not the minimum demo; add tests, run them, and update docs. Deliver one mergeable PR per job.'
# END TIER SCOPE
cat <<'F'

RULES: You are working in a fresh git worktree of ashlrai/REPO_ at its default branch. Work autonomously to a complete, tested, shippable change; be ambitious and high-leverage, and delete dead code you find in the area you touch. Add or update tests and run the repo's typecheck, lint and the touched tests (use a temporary HOME for any test run, e.g. HOME=$(mktemp -d); for cargo keep RUSTUP_HOME/CARGO_HOME pointing at the real toolchain). Never weaken, skip or delete tests to go green, and never weaken security controls. Without a security pass, do not add widened workflow permissions or id-token, new secrets.* refs, pull_request_target or workflow_run triggers, or third-party actions not pinned to a 40-hex commit SHA; other .github/**, CODEOWNERS and release config edits are allowed. Never print secrets or tokens. Do NOT commit, push, tag or publish: leave every change uncommitted in the worktree. When done, write BRIDGE_NOTES.md at the worktree root with a summary, commands run, pass/fail counts and net LOC.
If the full goal cannot be verified, ship the smallest correct, useful part with honest output (for example, age: unknown) and list the gap in BRIDGE_NOTES.md for the PR body. Use EMPTY only when already done or truly impossible.
If you finish with no change, end your final message with the line EMPTY_REASON: <code> and put the same line first in BRIDGE_NOTES.md; code is duplicate-landed (name the PR or commit that already covers it), prompt-unclear (name the missing detail), blocked (tool, auth or environment) or no-change-needed.
F
[ "$NOWT" = 1 ] && echo "NOTE: this worktree is index-only (no files on disk, by design). Read files with git show HEAD:<path>. Do not change code; this job only decides and closes PRs."
} | sed "s/REPO_/$REPO/" > $R/$J.prompt
cd $WT
case $POOL in codex-local) FAM=codex-local; DM=fast;; codex*) FAM=codex; DM=gpt-6.1-sol;; claude) FAM=claude; DM=opus;; claude-api) FAM=claude-api; DM=sonnet;; gemini) FAM=gemini; DM=gemini-2.5-pro;; zai) FAM=zai; DM=glm-5.3;; agy) FAM=agy; DM=gemini-3.8-flash-high;; grok) FAM=grok; DM=grok-4.7;; cursor) FAM=cursor; DM=auto;; *) FAM=$POOL; DM=swe-2-max;; esac
M=$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));p,f,t=sys.argv[2:5];print(next((str(d[k]) for k in (p+"."+t,p,f+"."+t,f) if d.get(k)),""))' "$R/models.json" "$POOL" "$FAM" "$TIER" 2>/dev/null); [[ "$M" =~ ^[A-Za-z0-9._-]+$ ]] || M=$DM; EF=$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));p,f,t=sys.argv[2:5];print(d.get("effort."+p+"."+t) or d.get("effort."+f+"."+t) or "")' "$R/models.json" "$POOL" "$FAM" "$TIER" 2>/dev/null); [[ -z "$EF" || "$EF" =~ ^[a-z]+$ ]] || EF=
# Paid Devin variants must never reach the launcher, even from models.json.
if [[ "$POOL" == devin && "$M" == *-[lL][iI][gG][hH][tT][nN][iI][nN][gG] ]]; then
  echo "PAID_MODEL_BLOCKED $J $M -> swe-2-max" >> "$R/$J.base.meta"
  M=swe-2-max
fi
echo "MODEL $POOL $TIER $M ${EF:-default}" >> $R/$J.base.meta   # RQ-TERA-LANE: lane key ($POOL.$TIER, $POOL) before family key; args via argv
# RQ-SEC-RUNLOG-SCRUB: env allowlist (real HOME kept so codex/devin find auth; CODEX_HOME passed only as the lane uses it) + scrubbed log
E=(env -i HOME="$HOME" CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 PATH="$PATH" TERM=xterm-256color LANG=en_US.UTF-8 USER="$USER" LOGNAME="$USER" TMPDIR="$TMPDIR" ${PHANTOM_SESSION_KEYS:+PHANTOM_SESSION_KEYS="$PHANTOM_SESSION_KEYS"}); SCRUB="perl $R/bin/scrub.pl"
# >>> LANE-MCP rev1 (Security 2026-11-03): one shared credential-free MCP set for every lane (context7 remote HTTPS + safe-fetch stdio
# with an SSRF guard). No keys, headers or env in any of these files; ~/.lane-mcp is write-denied in every .sb; each file is sha-checked here.
LM=$HOME/.lane-mcp; LM_SF=a71d18094c6a4989f8d1f5df027567e90a1416d03ec409ef5d2ea5c002a6c2ecf; LM_MJ=ac8f015184e214e3831dfb7aef35a3f67d645b8147e1fb6015946d7eef850de2f
lm_ok(){ local f=$1 want=$2; [ -d "$LM" ] && [ ! -L "$LM" ] && [ -O "$LM" ] && [ ! -L "$LM/safe-fetch.py" ] && [ "$(shasum -a 256 "$LM/safe-fetch.py" | cut -d' ' -f1)" = "${LM_SF#a}" ] \
  && [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -f %Lp "$f")" = 444 ] && [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "${want#a}" ] || { echo "REFUSED: lane MCP file $f missing, not 444 or sha mismatch"; exit 5; }; }
LMC=(-c 'mcp_servers.context7.url="https://mcp.context7.com/mcp"' -c 'mcp_servers.fetch.command="/usr/bin/python3"' -c "mcp_servers.fetch.args=[\"-I\",\"$LM/safe-fetch.py\"]")
# <<< LANE-MCP rev1
# Native lanes have no API pacing reservation. A fresh kernel check follows
# their last existing preflight and runs synchronously before background spawn.
native_pressure_ok(){
  local f="$R/bin/host_pressure_admission.py" want=6b2e87df1253fbf501a31553562293e26862871b30d9823a5c87a4fe3ed15e80
  local o="$R/bin/host_session_observation.py" owant=dfee0279acfa7f20bc93ce743c4afcc6581fb3f42f0cf62675c41a9513ef40de
  [ -f "$o" ] && [ ! -L "$o" ] && [ -O "$o" ] && [ "$(shasum -a 256 "$o" | cut -d' ' -f1)" = "$owant" ] && [ -f "$f" ] && [ ! -L "$f" ] && [ -O "$f" ] && [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$want" ] && /usr/bin/python3 -I "$f" || { echo "HELD: fresh kernel pressure unavailable or unsafe"; return 3; }
}
# >>> LOCALBUILD rev1 (Security 2026-11-03; Mason 9:22 and 9:24 PM ET): RQ-APP-LOCALBUILD job ids run the repo's own unsigned nightly
# desktop build (scripts/build-desktop-nightly.mjs) deterministically, with no agent and whatever pool was picked, under localbuild.sb.
# Network ON (Mason 9:24 PM). Toolchain is the provisioned, sha-verified ~/.localbuild-lane/tool/v1 (provision-localbuild.sh, run by Masbot
# outside any sandbox); its MANIFEST sha is checked here. No signing: keychain, security, codesign, notarytool and productsign stay denied.
if [[ "$J" =~ ^RQ-APP-LOCALBUILD(-[A-Za-z0-9]+)?$ ]]; then
  LBD=$HOME/.localbuild-lane; LBT=$LBD/tool/v1; LSB=$R/bin/localbuild.sb; LSB_SHA=$(pinsha localbuild.sb)
  LBM_SHA=27c0f1e6b47c0dae53ec1a7f8c1f25d1d866fe7ad30f8225f344300466c34c55; ART=$R/artifacts/$J
  [ "$REPO" = phantom ] || { echo "HELD: localbuild only builds ashlrai/phantom"; exit 3; }
  { [ -f "$LSB" ] && [ ! -L "$LSB" ] && [ "$(shasum -a 256 "$LSB" | cut -d' ' -f1)" = "$LSB_SHA" ]; } || { echo "REFUSED: localbuild.sb missing or sha mismatch"; exit 5; }
  { [ -d "$LBD" ] && [ ! -L "$LBD" ] && [ -O "$LBD" ] && [ "$(stat -f %Lp "$LBD")" = 700 ] && [ -d "$LBT" ] && [ ! -L "$LBT" ] && [ -f "$LBT/MANIFEST" ] && [ ! -L "$LBT/MANIFEST" ] \
    && [ "$(shasum -a 256 "$LBT/MANIFEST" | cut -d' ' -f1)" = "$LBM_SHA" ]; } || { echo "HELD: localbuild toolchain v1 not provisioned or MANIFEST mismatch"; exit 3; }
  mkdir -p -m 700 "$R/artifacts" "$ART" "$LBD/home" "$LBD/cache/npm" "$LBD/cache/cargo" || exit 1
  [ ! -L "$ART" ] && [ ! -L "$WT" ] || { echo "REFUSED: localbuild symlinked path"; exit 5; }
  echo "LOCALBUILD $J toolchain=v1" >> "$R/$J.base.meta"
  { nohup env -i HOME="$LBD/home" PATH="$LBT/bin:/usr/bin:/bin:/usr/sbin:/sbin" TERM=xterm-256color LANG=en_US.UTF-8 USER="$USER" LOGNAME="$USER" TMPDIR="$TMPDIR" \
      CI=true CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 CARGO_HOME="$LBD/cache/cargo" npm_config_cache="$LBD/cache/npm" npm_config_update_notifier=false \
      sandbox-exec -D WT="$WT" -D ART="$ART" -f "$LSB" "$LBT/bin/node" scripts/build-desktop-nightly.mjs --out "$ART" </dev/null 2>&1 | $SCRUB > "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } &
  echo "launched $J localbuild pid $! base ${BASE:0:9}"; exit 0
fi
# <<< LOCALBUILD rev1
case $POOL in
 codex-cmp) lm_ok "$LM/mcp.json" "$LM_MJ"; native_pressure_ok || exit 3; { nohup "${E[@]}" ${CODEX_HOME:+CODEX_HOME="$CODEX_HOME"} sandbox-exec -f $R/bin/codex-cmp.sb codex exec -m $M ${EF:+-c model_reasoning_effort=$EF} "${LMC[@]}" -c web_search=live --sandbox danger-full-access -C $WT - < $R/$J.prompt 2>&1 | $SCRUB > $R/$J.log; rcw "${PIPESTATUS[0]}"; } & ;;
 codex-personal) lm_ok "$LM/mcp.json" "$LM_MJ"; lm_ok "$HOME/.codex-2/lane.config.toml" adfc46b45a74f9589e1f9a0de0ea758c2906a54c8d1e8b1e8f04291bb85e45e96   # APPS-ALLOWLIST rev1g: deny-by-default codex_apps profile
  native_pressure_ok || exit 3; { nohup "${E[@]}" CODEX_HOME="$HOME/.codex-2" sandbox-exec -f $R/bin/codex-personal.sb codex exec -p lane -m $M ${EF:+-c model_reasoning_effort=$EF} "${LMC[@]}" -c web_search=live --sandbox danger-full-access -C $WT - < $R/$J.prompt 2>&1 | $SCRUB > $R/$J.log; rcw "${PIPESTATUS[0]}"; } & ;;
 claude) lm_ok "$LM/mcp.json" "$LM_MJ"   # >>> CLAUDE-BROKER rev1 (Security 2026-11-04)
  # The lane never holds a Claude credential: claude talks to the loopback broker with a dummy bearer; the broker (outside every
  # sandbox) injects the one fleet setup-token. claude-cli.sb now denies the keychain, /usr/bin/security and ~/.claude-fleet-broker.
  CB=$R/bin/claude-broker.py; CB_SHA=27dc7dbcd8b8b89dd126ed62792c0be4838b4025875a4ef62ef683c91628de81; CBP=8790; CBU=http://127.0.0.1:$CBP
  { [ -f "$CB" ] && [ ! -L "$CB" ] && [ "$(shasum -a 256 "$CB" | cut -d' ' -f1)" = "$CB_SHA" ]; } || { echo "REFUSED: claude-broker.py missing or sha mismatch"; exit 5; }
  if ! /usr/bin/curl -s -m 2 -o /dev/null -I "$CBU/api/hello"; then
    ( umask 077; nohup /usr/bin/lockf -s -t 0 "$R/queue/run/claude-broker.lock" env -i HOME="$HOME" PATH=/usr/bin:/bin LANG=en_US.UTF-8 /usr/bin/python3 -I "$CB" --port $CBP \
        >> "$R/queue/run/claude-broker.log" 2>&1 < /dev/null & ); sleep 1
    /usr/bin/curl -s -m 2 -o /dev/null -I "$CBU/api/hello" || { echo "HELD: claude-broker not running (token not provisioned? see queue/run/claude-broker.log)"; exit 3; }
  fi
  { nohup "${E[@]}" ANTHROPIC_BASE_URL="$CBU" CLAUDE_CODE_OAUTH_TOKEN=ashlr-lane-dummy-not-a-credential CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
      sandbox-exec -f $R/bin/claude-cli.sb claude -p --dangerously-skip-permissions --strict-mcp-config --mcp-config "$LM/mcp.json" --model $M --output-format stream-json --verbose < $R/$J.prompt 2>&1 | $SCRUB > $R/$J.log; rcw "${PIPESTATUS[0]}"; } & ;;   # <<< CLAUDE-BROKER rev1
 claude-api) # >>> claude-api lane (Mason 10:28 PM Oct 26): gifted + monthly Anthropic API credits, paced by claude-api.py
  # key: Phantom Secrets first (phantom exec injects it; the value never reaches this script), else a mode-600 user-owned
  # non-symlink key file read on fd 3 by the child itself (never on argv, never echoed or logged); neither -> HOLD exit 3
  umask 077
  KF=$R/bin/anthropic.key; KM=
  if command -v phantom >/dev/null 2>&1 && phantom list --json 2>/dev/null | grep -q '"ANTHROPIC_API_KEY"'; then KM=phantom
  elif [ -L "$KF" ]; then echo "HELD: anthropic.key refused (is a symlink)"; exit 3
  elif [ -f "$KF" ]; then
    KP=$(stat -c %a "$KF" 2>/dev/null || stat -f %Lp "$KF" 2>/dev/null)
    if [ -O "$KF" ] && [ "$KP" = 600 ] && [ -s "$KF" ]; then KM=file; else echo "HELD: anthropic.key refused (needs mode 600 and owned by $USER; is $KP)"; exit 3; fi
  fi
  # claude-org (Mason Nov 2): Console org OAuth login in ~/.claude-org bills the AshlrAI org API credits; preferred over keys
  # Security 2026-11-02 option (c): key copied Keychain->lane.key outside the sandbox by claude-org-token.sh; fd 3 only, never on argv or disk logs
  CO=$HOME/.claude-org; OKF=$CO/lane.key; [ -s "$OKF" ] || "$R/bin/claude-org-token.sh" >/dev/null 2>&1
  if [ ! -L "$OKF" ] && [ -O "$OKF" ] && [ "$(stat -f %Lp "$OKF")" = 600 ] && [ -s "$OKF" ]; then KM=org; fi
  [ -n "$KM" ] || { echo "HELD: no Anthropic API key (Phantom Secrets ANTHROPIC_API_KEY or $R/bin/anthropic.key)"; exit 3; }
  CAQ=$(python3 "$R/bin/claude-api.py" gate "$J" "$TIER" "$M"); [ $? -eq 0 ] || { echo "${CAQ:-HELD: claude-api gate failed}"; exit 3; }
  CAPOOL=${CAQ%% *}; M=${CAQ#* }
  [[ "$M" =~ ^[A-Za-z0-9._-]+$ && "$CAPOOL" =~ ^(gift|monthly)$ ]] || { echo "HELD: claude-api bad model or pool from gate"; rm -f "$R/queue/run/$J.api.reserve"; exit 3; }
  echo "CLAUDE_API $J pool=$CAPOOL model=$M key=$KM" >> "$R/$J.base.meta"
  lm_ok "$LM/mcp.json" "$LM_MJ"
  CMD=(sandbox-exec -f "$R/bin/claude.sb" claude -p --dangerously-skip-permissions --strict-mcp-config --mcp-config "$LM/mcp.json" --model "$M" --output-format json)
  # stdout (the JSON result) and stderr both pass through scrub.pl before touching disk; the scrubbed JSON is deleted once
  # record has taken the cost fields, so no raw or scrubbed agent stdout persists under .ashlr-runs
  ( umask 077; : > "$R/$J.log"
    { { if [ $KM = org ]; then "${E[@]}" CLAUDE_CONFIG_DIR="$CO" /bin/bash -c 'unset CLAUDE_CODE_OAUTH_TOKEN; IFS= read -r ANTHROPIC_API_KEY <&3; exec 3<&-; export ANTHROPIC_API_KEY; exec "$@"' claude-api "${CMD[@]}" 3< "$OKF"
        elif [ $KM = phantom ]; then "${E[@]}" phantom exec -- env -u CLAUDE_CODE_OAUTH_TOKEN "${CMD[@]}"
        else "${E[@]}" /bin/bash -c 'unset CLAUDE_CODE_OAUTH_TOKEN; IFS= read -r ANTHROPIC_API_KEY <&3; exec 3<&-; export ANTHROPIC_API_KEY; exec "$@"' claude-api "${CMD[@]}" 3< "$KF"; fi \
          < "$R/$J.prompt" 2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.api.json"; }
    python3 "$R/bin/claude-api.py" record "$J" "$TIER" "$M" "$CAPOOL" "$R/$J.api.json" 2>&1 | $SCRUB >> "$R/$J.log"
    rm -f "$R/$J.api.json" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< claude-api lane
 codex-local) # >>> RQ-LOCAL-LANE: Codex CLI -> oMLX loopback proxy (it injects the key; the job never sees one). No API key is passed:
  # the omlx provider has no env_key, so codex sends no Authorization header. Profile codex-local.sb is sha-pinned; mismatch refuses.
  # rev1.2: ~/.codex-local has no config.toml; the provider is defined and selected entirely by -c flags here (keys per codex
  # ModelProviderInfo: name, base_url, wire_api=responses; requires_openai_auth=false -> unauthenticated, no env_key).
  LSB=$R/bin/codex-local.sb; LSB_SHA=$(pinsha codex-local.sb)
  { [ -f "$LSB" ] && [ ! -L "$LSB" ] && [ "$(shasum -a 256 "$LSB" | cut -d' ' -f1)" = "$LSB_SHA" ]; } || { echo "REFUSED: codex-local.sb missing or sha mismatch"; exit 5; }
  case "$M" in fast|strong) ;; *) echo "HELD: bad codex-local model"; exit 3;; esac
  curl -sf -m 2 --noproxy '*' http://127.0.0.1:8123/v1/models >/dev/null || { echo "HELD: codex-local unhealthy"; exit 3; }
  { nohup "${E[@]}" CODEX_HOME="$HOME/.codex-local" HF_HUB_OFFLINE=1 env -u PHANTOM_SESSION_KEYS sandbox-exec -f "$LSB" codex exec "${LMC[@]}" \
   -c model_provider=omlx -c 'model_providers.omlx.name="omlx"' -c 'model_providers.omlx.base_url="http://127.0.0.1:8123/v1"' \
   -c 'model_providers.omlx.wire_api="responses"' -c model_providers.omlx.requires_openai_auth=false -m "$M" --sandbox danger-full-access -C "$WT" - < $R/$J.prompt 2>&1 | $SCRUB > $R/$J.log; rcw "${PIPESTATUS[0]}"; } & ;;
  # <<< RQ-LOCAL-LANE
 gemini) # >>> GEMINI-LANE (Security rev1 2026-11-03): personal Google OAuth (Code Assist for individuals) only, paced by gemini-pace.py
  # E is env -i, so no GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENAI_*, GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT or Vertex var reaches
  # the CLI. The sha-pinned system settings (highest precedence in 0.66.0) enforce auth oauth-personal, usage stats and telemetry off, no local
  # .env, and no hooks, MCP, extensions or skills. SANDBOX=sandbox-exec stops the CLI relaunching its own sandbox and moves its runtime dir to
  # ~/.cache/.gemini; gemini.sb leaves only the oauth_creds.json refresh writable under ~/.gemini. Prompt goes on stdin, never argv.
  GSB=$R/bin/gemini.sb; GSB_SHA=$(pinsha gemini.sb)
  GSS=$HOME/.gemini-lane/system-settings.json; GSS_SHA=965931d4ed1eb078a5f3837440a9249044c44a375c57888f6a422075f7054803
  { [ -f "$GSB" ] && [ ! -L "$GSB" ] && [ "$(shasum -a 256 "$GSB" | cut -d' ' -f1)" = "$GSB_SHA" ]; } || { echo "REFUSED: gemini.sb missing or sha mismatch"; exit 5; }
  { [ -f "$GSS" ] && [ ! -L "$GSS" ] && [ "$(shasum -a 256 "$GSS" | cut -d' ' -f1)" = "$GSS_SHA" ]; } || { echo "REFUSED: gemini system settings missing or sha mismatch"; exit 5; }
  lm_ok "$GSS" "a$GSS_SHA"   # LANE-MCP rev1: gemini MCP servers live in the pinned system settings
  [ -f "$HOME/.gemini/oauth_creds.json" ] || { echo "HELD: gemini not signed in (personal OAuth)"; exit 3; }
  GQ=$(python3 "$R/bin/gemini-pace.py" gate "$J" "$TIER"); [ $? -eq 0 ] || { echo "${GQ:-HELD: gemini gate failed}"; exit 3; }
  # stdout (the JSON result) and stderr both pass through scrub.pl; record reads the stats, prints at most one fixed classifier line
  # (gemini-pace: quota_exhausted terminal|retryable, gemini-pace: auth_failed) for dispatchd AB_RX, then the JSON is deleted
  ( umask 077; : > "$R/$J.log"
    { { "${E[@]}" SANDBOX=sandbox-exec GEMINI_CLI_SYSTEM_SETTINGS_PATH="$GSS" GEMINI_CLI_TRUST_WORKSPACE=true GOOGLE_GENAI_USE_GCA=true \
          GEMINI_TELEMETRY_ENABLED=false GEMINI_FORCE_FILE_STORAGE=true sandbox-exec -f "$GSB" gemini -p "" --approval-mode yolo --output-format json -m "$M" \
          < "$R/$J.prompt" 2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.gemini.json"; }
    python3 "$R/bin/gemini-pace.py" record "$J" 0 "$R/$J.gemini.json" "$R/$J.log" 2>&1 | $SCRUB >> "$R/$J.log"
    rm -f "$R/$J.gemini.json" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< gemini lane
 zai) # >>> ZAI-LANE rev1 (Security 2026-11-03): Z.ai GLM Coding Plan Lite via Claude Code, paced by zai-pace.py
  # E is env -i: no ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, other provider key or base URL is inherited. The base URL and model ids
  # are literals here; nothing from the queue, models.json or env can change them. The key is read on fd 3 by the child bash right
  # before exec (never argv, never a shell var in this script, never logged). Only --setting-sources user is loaded, from the
  # sha-pinned settings.json in the lane's own CLAUDE_CONFIG_DIR, so a repo's .claude/settings.json cannot set env or hooks.
  ZD=$HOME/.zai-lane; KF=$ZD/api_key; ZC=$ZD/claude; ZSB=$R/bin/zai.sb; ZSB_SHA=$(pinsha zai.sb); ZST=$ZC/settings.json; ZST_SHA=3a85cc369f6cd3b30a20b7ec596117c92866d6782233369d5fe7a66bf8554bfb
  { [ -f "$ZSB" ] && [ ! -L "$ZSB" ] && [ "$(shasum -a 256 "$ZSB" | cut -d' ' -f1)" = "$ZSB_SHA" ]; } || { echo "REFUSED: zai.sb missing or sha mismatch"; exit 5; }
  { [ -f "$ZST" ] && [ ! -L "$ZST" ] && [ "$(shasum -a 256 "$ZST" | cut -d' ' -f1)" = "$ZST_SHA" ]; } || { echo "REFUSED: zai settings.json missing or sha mismatch"; exit 5; }
  { [ -d "$ZD" ] && [ ! -L "$ZD" ] && [ -O "$ZD" ] && [ "$(stat -f %Lp "$ZD")" = 700 ] && [ -f "$KF" ] && [ ! -L "$KF" ] && [ -O "$KF" ] && [ "$(stat -f %Lp "$KF")" = 600 ] && [ -s "$KF" ]; } || { echo "HELD: zai api_key refused (needs dir 700, file 600, owned by $USER)"; exit 3; }
  case "$TIER" in fast) M=glm-5.3-flash; ZT=40;; work) M=glm-5.3; ZT=60;; *) echo "HELD: zai tier must be fast or work"; exit 3;; esac
  ZQ=$(python3 "$R/bin/zai-pace.py" gate "$J" "$TIER"); [ $? -eq 0 ] || { echo "${ZQ:-HELD: zai gate failed}"; exit 3; }
  echo "ZAI $J model=$M max_turns=$ZT" >> "$R/$J.base.meta"
  lm_ok "$LM/mcp.json" "$LM_MJ"
  CMD=(sandbox-exec -f "$ZSB" claude -p --dangerously-skip-permissions --setting-sources user --strict-mcp-config --mcp-config "$LM/mcp.json" --max-turns "$ZT" --model "$M" --output-format json)
  # stdout (the JSON result) and stderr both pass through scrub.pl; record charges credits from usage, prints at most one fixed
  # classifier line (zai-pace: quota_exhausted <kind> | auth_failed | rate_limited) for dispatchd AB_RX, then the JSON is deleted
  ( umask 077; : > "$R/$J.log"
    { { "${E[@]}" CLAUDE_CONFIG_DIR="$ZC" ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic \
          ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3 ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.3 ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.3-flash \
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1 API_TIMEOUT_MS=3000000 \
          /bin/bash -c 'unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; IFS= read -r ANTHROPIC_AUTH_TOKEN <&3; exec 3<&-; export ANTHROPIC_AUTH_TOKEN; exec "$@"' zai "${CMD[@]}" 3< "$KF" \
          < "$R/$J.prompt" 2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.zai.json"; }
    python3 "$R/bin/zai-pace.py" record "$J" 0 "$R/$J.zai.json" "$R/$J.log" 2>&1 | $SCRUB >> "$R/$J.log"
    python3 -I -c 'import json,sys;print(str(json.load(open(sys.argv[1])).get("result",""))[:20000])' "$R/$J.zai.json" 2>/dev/null | $SCRUB >> "$R/$J.log"
    rm -f "$R/$J.zai.json" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< zai lane
 agy) # >>> AGY-LANE rev1c+rev1e (rev1e: tier mid maps to the work model, defense in depth; dispatchd never routes mid here) (Security 2026-11-03; rev1c: probe fixes on 1.4.12, -p last, event stdin shape, pinned 444 settings.json): Antigravity CLI, Google OAuth file token in a lane-only HOME, paced by agy-pace.py
  # E is env -i: no GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_CLOUD_PROJECT, GOOGLE_APPLICATION_CREDENTIALS or ANTIGRAVITY_* var reaches agy.
  # HOME=~/.agy-lane/home isolates agy's config, state and file token (keychain exec is denied in agy.sb) from ~/.gemini and the
  # Antigravity app; ADC lookups resolve inside it (none there). Per-run --settings forces useG1Credits off (no paid AI-credit
  # overage; 1.4.12 accepts no telemetry key); persistent settings, plugins, MCP auth, hooks and the updater are write-denied in agy.sb.
  # Prompt goes on stdin as one stream-json user message (never argv). Model ids are literals by tier.
  AD=$HOME/.agy-lane; AH=$AD/home; ASB=$R/bin/agy.sb; ASB_SHA=$(pinsha agy.sb)
  { [ -f "$ASB" ] && [ ! -L "$ASB" ] && [ "$(shasum -a 256 "$ASB" | cut -d' ' -f1)" = "$ASB_SHA" ]; } || { echo "REFUSED: agy.sb missing or sha mismatch"; exit 5; }
  { [ -d "$AD" ] && [ ! -L "$AD" ] && [ -O "$AD" ] && [ "$(stat -f %Lp "$AD")" = 700 ] && [ -d "$AH" ] && [ ! -L "$AH" ] && [ -O "$AH" ]; } || { echo "HELD: agy lane home missing or not 700 (one-time in-sandbox sign-in needed)"; exit 3; }
  # rev1c: agy 1.4.12 reads only useG1Credits from settings (telemetry keys are rejected; no data-sharing key exists in the CLI), so the
  # lane settings.json pins useG1Credits false against an inherited true; it must match its sha, be 444 and not a symlink (write-denied in agy.sb).
  AST=$AH/.gemini/antigravity-cli/settings.json; AST_SHA=565e3cb29356f2a2216f840b0cc1931a14977dbc38b3298e8f961a767c8b0ac5
  lm_ok "$AH/.gemini/config/mcp_config.json" a03ca83e924b412844963deac581e0c5b8432f4bfac48b9a62e3fb00d7f5951c9   # LANE-MCP rev1
  { [ -f "$AST" ] && [ ! -L "$AST" ] && [ "$(stat -f %Lp "$AST")" = 444 ] && [ "$(shasum -a 256 "$AST" | cut -d' ' -f1)" = "$AST_SHA" ]; } || { echo "REFUSED: agy settings.json missing, not 444 or sha mismatch"; exit 5; }
  case "$TIER" in fast) M=gemini-3.8-flash-medium; AT=900s;; work|mid) M=gemini-3.8-flash-high; AT=2400s;; frontier) M=claude-opus-4-6-thinking; AT=2400s;; *) echo "HELD: agy tier must be fast, work or frontier"; exit 3;; esac
  [ "$TIER" = mid ] && TIER=work   # rev1e: mid runs and is paced as work
  AQ=$(python3 "$R/bin/agy-pace.py" gate "$J" "$TIER"); [ $? -eq 0 ] || { echo "${AQ:-HELD: agy gate failed}"; exit 3; }
  echo "AGY $J model=$M timeout=$AT" >> "$R/$J.base.meta"
  ( umask 077; : > "$R/$J.log"
    { { python3 -I -c 'import json,sys;print(json.dumps({"event":"user","message":{"role":"user","content":sys.stdin.read()}}))' < "$R/$J.prompt" | \
        "${E[@]}" HOME="$AH" GIT_CONFIG_GLOBAL="$HOME/.gitconfig" sandbox-exec -f "$ASB" /opt/homebrew/bin/agy --input-format stream-json --output-format stream-json \
          --print-timeout "$AT" --model "$M" --dangerously-skip-permissions --disable-slash-commands --settings '{"useG1Credits":false}' -p '' \
          2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[1]}"; } 4>&1 | $SCRUB > "$R/$J.agy.ndjson"; }
    python3 "$R/bin/agy-pace.py" record "$J" 0 "$R/$J.agy.ndjson" "$R/$J.log" 2>&1 | $SCRUB >> "$R/$J.log"
    tail -c 20000 "$R/$J.agy.ndjson" | $SCRUB >> "$R/$J.log"
    rm -f "$R/$J.agy.ndjson" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< agy lane
 grok) # >>> GROK-LANE rev1d (Security 2026-11-03; rev1d: vendored sha-pinned binary, parent XAI_API_KEY only warns): grok CLI on Mason's SuperGrok OAuth (grok login), paced by grok-pace.py
  # Metered-key paths: E (env -i) is a fixed allowlist, so XAI_API_KEY / GROK_CODE_XAI_API_KEY in the parent never reach grok
  # (rev1d: the parent having them is only a name-only warning; the launch is refused only if the constructed child env would carry one). HOME=~/.grok-lane/home relocates ~/.grok (verified on 1.0.46), so grok uses only the lane auth.json; no GROK_HOME,
  # GROK_CONFIG or endpoint override can reach it. Telemetry, trace upload, feedback, memory, the auto-updater and the ~/.claude and
  # ~/.cursor compat scans are off by env. The prompt is read by grok from the prompt file (headless grok does not read stdin); argv
  # carries only fixed flags. stdout (one JSON object) and stderr both pass through scrub.pl.
  [ -z "${XAI_API_KEY:-}${GROK_CODE_XAI_API_KEY:-}" ] || echo "WARN: XAI_API_KEY or GROK_CODE_XAI_API_KEY is set in the launcher env (name only); env -i keeps it out of the grok child" >> "$R/$J.base.meta"
  case " ${E[*]} " in *" XAI_API_KEY="*|*" GROK_CODE_XAI_API_KEY="*) echo "REFUSED: grok child env would carry an xAI API key (metered billing)"; exit 5;; esac
  GD=$HOME/.grok-lane; GH=$GD/home; GB=/Users/masonwyatt/.grok-lane/bin/grok; GB_SHA=e8daa302364c9c3b6a5546d511cfbd1ab5e5d407a9b04282f660665ea405f9f3; GV="grok 1.0.46 "; KSB=$R/bin/grok.sb; KSB_SHA=$(pinsha grok.sb)
  { [ -f "$KSB" ] && [ ! -L "$KSB" ] && [ "$(shasum -a 256 "$KSB" | cut -d' ' -f1)" = "$KSB_SHA" ]; } || { echo "REFUSED: grok.sb missing or sha mismatch"; exit 5; }
  lm_ok "$GH/.grok/config.toml" ad4add1ab2131d356727ab3263e5ed58259150867d394e7c742877816a37118b9   # LANE-MCP rev1
  { [ -d "$GD" ] && [ ! -L "$GD" ] && [ -O "$GD" ] && [ "$(stat -f %Lp "$GD")" = 700 ] && [ -d "$GH" ] && [ ! -L "$GH" ] && [ -O "$GH" ] && [ "$(stat -f %Lp "$GH")" = 700 ] \
    && [ -f "$GH/.grok/auth.json" ] && [ ! -L "$GH/.grok/auth.json" ] && [ "$(stat -f %Lp "$GH/.grok/auth.json")" = 600 ] && [ ! -L "$GH/.grok" ]; } || { echo "HELD: grok lane home or auth.json missing or wrong mode (dirs 700, auth.json 600)"; exit 3; }
  { [ -f "$GB" ] && [ ! -L "$GB" ] && [ ! -L "${GB%/grok}" ] && [ "$(stat -f %Lp "${GB%/grok}")" = 700 ] && [ "$(stat -f %Lp "$GB")" = 555 ] \
    && [ "$(shasum -a 256 "$GB" | cut -d' ' -f1)" = "$GB_SHA" ]; } || { echo "REFUSED: vendored grok binary missing, symlinked, wrong mode or sha mismatch"; exit 5; }
  { [ -x "$GB" ] && [ ! -L "$GB" ] && [[ "$(env -i HOME="$GH" PATH=/usr/bin:/bin sandbox-exec -f "$KSB" "$GB" --version 2>/dev/null </dev/null)" == "$GV"* ]]; } || { echo "HELD: grok binary is not the pinned version ($GV)"; exit 3; }
  case "$TIER" in fast) M=grok-4.7-build-fast; GE=; GT=40;; work|mid) M=grok-4.7; GE=; GT=60;; frontier) M=grok-4.7; GE=high; GT=80;; *) echo "HELD: grok tier must be fast, work or frontier"; exit 3;; esac
  [ "$TIER" = mid ] && TIER=work   # rev1e: mid runs and is paced as work
  KQ=$(python3 "$R/bin/grok-pace.py" gate "$J" "$TIER"); [ $? -eq 0 ] || { echo "${KQ:-HELD: grok gate failed}"; exit 3; }
  echo "GROK $J model=$M effort=${GE:-default} max_turns=$GT" >> "$R/$J.base.meta"
  ( umask 077; : > "$R/$J.log"
    { { "${E[@]}" HOME="$GH" GIT_CONFIG_GLOBAL="$HOME/.gitconfig" GROK_TELEMETRY_ENABLED=0 GROK_TELEMETRY_TRACE_UPLOAD=0 GROK_FEEDBACK_ENABLED=0 \
          GROK_DISABLE_AUTOUPDATER=1 GROK_CLAUDE_SKILLS_ENABLED=0 GROK_CURSOR_MCPS_ENABLED=0 GROK_MEMORY=0 GROK_MARKETPLACE_REQUIRE_SHA=1 \
          sandbox-exec -f "$KSB" "$GB" --prompt-file "$R/$J.prompt" --output-format json --no-auto-update --always-approve \
          --max-turns "$GT" -m "$M" ${GE:+--reasoning-effort "$GE"} --cwd "$WT" \
          </dev/null 2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.grok.json"; }
    python3 "$R/bin/grok-pace.py" record "$J" "$(cat "$R/queue/run/$J.rc" 2>/dev/null || echo 1)" "$R/$J.grok.json" "$R/$J.log" 2>&1 | $SCRUB >> "$R/$J.log"
    python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(str(d.get("text","") if isinstance(d,dict) else "")[:20000])' "$R/$J.grok.json" 2>/dev/null | $SCRUB >> "$R/$J.log"
    rm -f "$R/$J.grok.json" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< grok lane
 cursor) # >>> CURSOR-LANE rev1 (Security 2026-11-03): Cursor CLI on Mason's plan via a user API key, paced by cursor-pace.py
  # E is env -i: no CURSOR_AUTH_TOKEN, CURSOR_API_ENDPOINT, CURSOR_API_BASE_URL or other CURSOR_* override reaches the CLI. The key is read
  # on fd 3 by the child bash right before exec (never argv, never a shell var here, never logged); api_key is unreadable inside cursor.sb.
  # The binary is the pinned cask path (a brew upgrade changes the path and holds the lane; /opt/homebrew is write-denied, so no self-update).
  # rev1f: AGENT_CLI_CREDENTIAL_STORE=memory (read by cursor-agent's credential-store.ts) keeps the API-key login in memory, so it never
  # spawns /usr/bin/security to save to the keychain (that spawn was the probe's 'spawn EPERM'). The keychain stays denied.
  # cursor-agent takes the prompt only on argv, so argv carries a fixed pointer to the prompt file, never the prompt. --approve-mcps loads only the pinned 444 lane mcp.json (LANE-MCP rev1).
  CD=$HOME/.cursor-lane; CH=$CD/home; KF=$CD/api_key; CB=/opt/homebrew/Caskroom/cursor-cli/2026.10.22-27dcf5f/dist-package/cursor-agent; CSB=$R/bin/cursor.sb; CSB_SHA=$(pinsha cursor.sb)
  { [ -f "$CSB" ] && [ ! -L "$CSB" ] && [ "$(shasum -a 256 "$CSB" | cut -d' ' -f1)" = "$CSB_SHA" ]; } || { echo "REFUSED: cursor.sb missing or sha mismatch"; exit 5; }
  { [ -d "$CD" ] && [ ! -L "$CD" ] && [ -O "$CD" ] && [ "$(stat -f %Lp "$CD")" = 700 ] && [ -d "$CH" ] && [ ! -L "$CH" ] && [ -O "$CH" ] && [ "$(stat -f %Lp "$CH")" = 700 ] \
    && [ -f "$KF" ] && [ ! -L "$KF" ] && [ -O "$KF" ] && [ "$(stat -f %Lp "$KF")" = 600 ] && [ -s "$KF" ]; } || { echo "HELD: cursor api_key refused (needs dirs 700, file 600, owned by $USER)"; exit 3; }
  [ -x "$CB" ] && [ ! -L "$CB" ] || { echo "HELD: pinned cursor-cli 2026.10.22-27dcf5f not installed"; exit 3; }
  case "$TIER" in fast|work|mid) M=auto;; *) echo "HELD: cursor tier must be fast or work"; exit 3;; esac
  [ "$TIER" = mid ] && TIER=work   # rev1e: mid runs and is paced as work
  CQ=$(python3 "$R/bin/cursor-pace.py" gate "$J" "$TIER"); [ $? -eq 0 ] || { echo "${CQ:-HELD: cursor gate failed}"; exit 3; }
  echo "CURSOR $J model=$M" >> "$R/$J.base.meta"
  lm_ok "$CH/.cursor/mcp.json" a800de242bea0e4b894a344d99547e81c12c8e9e53d803ed88d154a1d5185c4f0
  CMD=(sandbox-exec -f "$CSB" "$CB" -p --output-format json --force --approve-mcps --trust --workspace "$WT" --model "$M" \
       "Your full task is in the file $R/$J.prompt. Read that file first and carry out exactly what it says.")
  ( umask 077; : > "$R/$J.log"
    { { "${E[@]}" HOME="$CH" NO_OPEN_BROWSER=1 AGENT_CLI_CREDENTIAL_STORE=memory GIT_CONFIG_GLOBAL="$HOME/.gitconfig" \
          /bin/bash -c 'unset CURSOR_AUTH_TOKEN CURSOR_API_ENDPOINT CURSOR_API_BASE_URL CURSOR_API_URL; IFS= read -r CURSOR_API_KEY <&3; exec 3<&-; export CURSOR_API_KEY; exec "$@"' cursor "${CMD[@]}" 3< "$KF" \
          </dev/null 2>&1 1>&4 4>&- | $SCRUB >> "$R/$J.log"; rcw "${PIPESTATUS[0]}"; } 4>&1 | $SCRUB > "$R/$J.cursor.json"; }
    python3 "$R/bin/cursor-pace.py" record "$J" "$(cat "$R/queue/run/$J.rc" 2>/dev/null || echo 1)" "$R/$J.cursor.json" "$R/$J.log" 2>&1 | $SCRUB >> "$R/$J.log"
    python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(str(d.get("result","") if isinstance(d,dict) else "")[:20000])' "$R/$J.cursor.json" 2>/dev/null | $SCRUB >> "$R/$J.log"
    rm -f "$R/$J.cursor.json" ) </dev/null >/dev/null 2>&1 &
  ;; # <<< cursor lane
 devin) native_pressure_ok || exit 3; { nohup "${E[@]}" sandbox-exec -f $R/bin/agent.sb devin --permission-mode dangerous --respect-workspace-trust false --model $M -p --prompt-file $R/$J.prompt 2>&1 | $SCRUB > $R/$J.log; rcw "${PIPESTATUS[0]}"; } & ;;
esac
child_pid=$!
# Observation only: registration cannot alter the launch outcome or signal the child.
case "$POOL" in
  codex-cmp|codex-personal|devin) /usr/bin/python3 -I "$R/bin/host_session_tick.py" register "$J" "$child_pid" >/dev/null 2>&1 || : ;;
esac
echo "launched $J $POOL pid $child_pid base ${BASE:0:9}"
