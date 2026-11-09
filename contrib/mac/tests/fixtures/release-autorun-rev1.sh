#!/bin/bash
# RELEASE-AUTORUN rev1 (GATES v4, Security 2026-11-04). launchd ai.ashlr.release-autorun, every 10 min, OUTSIDE every lane sandbox.
# Finds the newest successful attest-ci-build run on ashlrai/phantom, derives all release-sign.sh evidence by GET-only API reads,
# and runs bin/release-sign.sh once per sha when that sha is the target of a v* tag. Never retries after rc=14 (or 0/5/16).
# Until ~/.ashlr-runs/release-sign/keychain-allowed exists (Masbot creates it after Mason clicks Always Allow once), it only writes
# NEEDS-MASON-<tag> with the exact command and starts nothing. Kill switch: ~/.ashlr-runs/RELEASE_AUTORUN_OFF.
set -u; set +x; umask 077
REPO=ashlrai/phantom; R=${RA_ROOT_SELFTEST:-$HOME/.ashlr-runs}; ST=$R/release-sign; D=$ST/autorun
GH=${RA_GH_SELFTEST:-/opt/homebrew/bin/gh}; RS=${RA_RS_SELFTEST:-$R/bin/release-sign.sh}; SCRUB=$R/bin/scrub.pl
[ -f $R/RELEASE_AUTORUN_OFF ] && exit 0
mkdir -p -m 700 "$ST" "$D"; L=$D/autorun.log
log(){ echo "$(date '+%F %T') $*" | /usr/bin/perl "$SCRUB" >> "$L"; }
mkdir "$D/lock" 2>/dev/null || exit 0; trap 'rmdir "$D/lock" 2>/dev/null' EXIT
[ -d "$ST/lock" ] && { log "release-sign running, skip"; exit 0; }
G(){ "$GH" api --hostname github.com -H 'Accept: application/vnd.github+json' "$1"; }   # GET only
J(){ /usr/bin/python3 -I -c 'import json,sys
r=json.load(sys.stdin)
for p in sys.argv[1:]:
    d=r
    for k in p.split("."): d=d[int(k)] if isinstance(d,list) else (d.get(k) if isinstance(d,dict) else None)
    print("" if d is None else d)' "$@"; }
A=$(G "repos/$REPO/actions/workflows/attest-ci-build.yml/runs?status=success&per_page=1") || { log "read attest runs failed"; exit 0; }
read -r AR AA AS < <(echo "$A" | J workflow_runs.0.id workflow_runs.0.run_attempt workflow_runs.0.head_sha | paste -sd' ' -)
[ -n "${AR:-}" ] || exit 0
[ -f "$D/attest-$AR-$AA.seen" ] && exit 0
BA=$(G "repos/$REPO/actions/runs/$AR/artifacts?per_page=100") || { log "read attest artifacts failed"; exit 0; }
read -r BART BNAME < <(echo "$BA" | /usr/bin/python3 -I -c 'import json,sys,re
for a in json.load(sys.stdin)["artifacts"]:
    if re.fullmatch(r"ashlr-attested-[1-9][0-9]*-[1-9][0-9]*-[1-9][0-9]*-[1-9][0-9]*", a["name"]) and not a["expired"]: print(a["id"], a["name"]); break')
[ -n "${BART:-}" ] || { log "attest $AR/$AA: no attested handoff"; touch "$D/attest-$AR-$AA.seen"; exit 0; }
IFS=- read -r _ _ CI CA AR2 AA2 <<< "$BNAME"; [ "$AR2" = "$AR" ] && [ "$AA2" = "$AA" ] || { log "attest $AR: handoff name mismatch"; touch "$D/attest-$AR-$AA.seen"; exit 0; }
HEAD=$(G "repos/$REPO/actions/runs/$CI/attempts/$CA" | J head_sha) || exit 0
CART=$(G "repos/$REPO/actions/runs/$CI/artifacts?per_page=100" | /usr/bin/python3 -I -c 'import json,sys
n=sys.argv[1]
print(next((a["id"] for a in json.load(sys.stdin)["artifacts"] if a["name"]==n and not a["expired"]), ""))' "ashlr-build-$CI-$CA")
TAG=$(G "repos/$REPO/tags?per_page=100" | /usr/bin/python3 -I -c 'import json,sys,re
h=sys.argv[1]
print(next((t["name"] for t in json.load(sys.stdin) if t["commit"]["sha"]==h and re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", t["name"])), ""))' "$HEAD")
[ -n "$TAG" ] || { log "attest $AR: sha ${HEAD:0:12} carries no v* tag, not a release"; touch "$D/attest-$AR-$AA.seen"; exit 0; }
AUD=$(G "repos/$REPO/actions/workflows/dependency-audit.yml/runs?head_sha=$HEAD&status=success&per_page=1")
read -r AU UA < <(echo "$AUD" | J workflow_runs.0.id workflow_runs.0.run_attempt | paste -sd' ' -)
[ -n "$CART" ] && [ -n "${AU:-}" ] || { log "$TAG ${HEAD:0:12}: build artifact or audit run missing; will look again"; exit 0; }
DONE=$D/sha-$HEAD
if [ -f "$DONE.rc" ]; then exit 0; fi   # once per sha: any recorded outcome is final (never retries rc=14)
CMD=("$RS" --tag "$TAG" --head-sha "$HEAD" --ci-run "$CI" --ci-attempt "$CA" --artifact-id "$CART" --bundle-artifact-id "$BART" \
  --attestor-run "$AR" --attestor-attempt "$AA" --attestor-sha "$AS" --audit-run "$AU" --audit-attempt "$UA")
if [ ! -f "$ST/keychain-allowed" ]; then
  M=$ST/NEEDS-MASON-$TAG
  [ -f "$M" ] || { printf 'NEEDS-MASON %s sha %s\nFirst signing run needs Mason at the Mac for the one Always Allow click.\nRun from his Terminal:\n/bin/bash %s\nThen Masbot: touch %s/keychain-allowed\n' "$TAG" "$HEAD" "${CMD[*]}" "$ST" > "$M"; log "NEEDS-MASON $TAG ${HEAD:0:12} (keychain-allowed absent)"; }
  exit 0
fi
log "START $TAG ${HEAD:0:12} ci=$CI/$CA attest=$AR/$AA audit=$AU/$UA"
: > "$DONE.started"
/bin/bash "${CMD[@]}" >/dev/null 2>&1; rc=$?
echo $rc > "$DONE.rc"; touch "$D/attest-$AR-$AA.seen"
log "END $TAG ${HEAD:0:12} rc=$rc"
[ $rc = 14 ] && printf 'NEEDS-MASON %s: publish failed (rc=14). Not retried. Inspect the draft release, then rm %s.rc to allow one manual rerun.\n' "$TAG" "$DONE" > "$ST/NEEDS-MASON-$TAG-rc14"
exit 0
