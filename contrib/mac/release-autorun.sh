#!/bin/bash
# RELEASE-AUTORUN rev1 private selection proposal (GATES v4, Security 2026-11-04). launchd ai.ashlr.release-autorun, every 10 min, OUTSIDE every lane sandbox.
# Finds the newest ready current-source successful attest-ci-build run on ashlrai/phantom, derives all release-sign.sh evidence by GET-only API reads,
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
# A prior started outcome without a completion is uncertain, not permission to replay.
for started in "$D"/sha-*.started; do
  [ -e "$started" ] || [ -L "$started" ] || continue
  [ -f "${started%.started}.rc" ] || { log "prior signing outcome uncertain; operator reconciliation required"; exit 0; }
done
artifact(){ /usr/bin/python3 -I -c 'import json,sys,re
r=json.load(sys.stdin); run,attempt,sha,role=sys.argv[1:]
rows=r["artifacts"]; assert isinstance(rows,list) and type(r["total_count"]) is int and r["total_count"]==len(rows)<=100
assert all(type(a.get("id")) is int and a["id"]>0 and isinstance(a.get("name"),str) for a in rows)
assert len({a["id"] for a in rows})==len(rows)
pattern=(r"ashlr-attested-[1-9][0-9]*-[1-9][0-9]*-"+run+"-"+attempt) if role=="attested" else "ashlr-build-"+run+"-"+attempt
matches=[a for a in rows if re.fullmatch(pattern,a["name"]) and a.get("expired") is not True]
assert len(matches)<=1
if matches:
 a=matches[0]; assert a.get("expired") is False and re.fullmatch(r"sha256:[a-f0-9]{64}",a.get("digest",""))
 w=a["workflow_run"]; assert type(w.get("id")) is int and w["id"]==int(run) and w.get("head_sha")==sha and w.get("repository_id")==1263526319 and w.get("head_repository_id")==1263526319
 print(a["id"],a["name"])' "$@"; }
valid_run(){ /usr/bin/python3 -I -c 'import json,sys
r=json.load(sys.stdin); run,attempt,sha,workflow=sys.argv[1:]
assert type(r.get("id")) is int and r["id"]==int(run) and type(r.get("run_attempt")) is int and r["run_attempt"]==int(attempt)
assert r.get("path")==".github/workflows/"+workflow+".yml" and r.get("head_sha")==sha and r.get("head_branch")=="master"
assert r.get("status")=="completed" and r.get("conclusion")=="success"
for key in ("repository","head_repository"):
 assert r[key].get("id")==1263526319 and r[key].get("full_name")=="ashlrai/phantom"' "$@"; }
M=$(G "repos/$REPO/commits/master" | J sha) || { log "read master failed"; exit 0; }
[[ "$M" =~ ^[a-f0-9]{40}$ ]] || { log "master identity unavailable"; exit 0; }
A=$(G "repos/$REPO/actions/workflows/attest-ci-build.yml/runs?status=success&per_page=20") || { log "read attest runs failed"; exit 0; }
CANDIDATES=$(echo "$A" | /usr/bin/python3 -I -c 'import json,sys,re
r=json.load(sys.stdin); rows=r["workflow_runs"]
assert isinstance(rows,list) and len(rows)<=20 and type(r["total_count"]) is int and r["total_count"]>=len(rows)
assert all(type(a.get("id")) is int and a["id"]>0 and type(a.get("run_attempt")) is int and a["run_attempt"]>0 for a in rows)
assert len({a["id"] for a in rows})==len(rows)
for a in sorted(rows,key=lambda a:a["id"],reverse=True):
 assert a.get("path")==".github/workflows/attest-ci-build.yml" and a.get("head_branch")=="master" and a.get("status")=="completed" and a.get("conclusion")=="success" and re.fullmatch(r"[a-f0-9]{40}",a.get("head_sha",""))
 for key in ("repository","head_repository"):
  assert a[key].get("id")==1263526319 and a[key].get("full_name")=="ashlrai/phantom"
 print(a["id"],a["run_attempt"],a["head_sha"])') || { log "attest run inventory invalid"; exit 0; }
while read -r AR AA AS; do
[ -n "${AR:-}" ] || continue
[ "$AS" = "$M" ] || continue   # unchanged signer also requires current attestor source
[ -f "$D/attest-$AR-$AA.seen" ] && continue
G "repos/$REPO/actions/runs/$AR" | valid_run "$AR" "$AA" "$AS" attest-ci-build 2>/dev/null || { log "attest $AR/$AA changed or invalid; held"; exit 0; }
BA=$(G "repos/$REPO/actions/runs/$AR/artifacts?per_page=100") || { log "read attest artifacts failed"; exit 0; }
BINDING=$(echo "$BA" | artifact "$AR" "$AA" "$AS" attested 2>/dev/null) || { log "attest $AR/$AA artifact inventory invalid; held"; exit 0; }
read -r BART BNAME <<< "$BINDING"
[ -n "${BART:-}" ] || { log "attest $AR/$AA: no current-attempt handoff yet"; continue; }
IFS=- read -r _ _ CI CA AR2 AA2 <<< "$BNAME"
[ "$AR2" = "$AR" ] && [ "$AA2" = "$AA" ] || { log "attest $AR/$AA handoff mismatch; held"; exit 0; }
CR=$(G "repos/$REPO/actions/runs/$CI/attempts/$CA") || { log "read producer failed"; exit 0; }
HEAD=$(echo "$CR" | J head_sha)
[[ "$HEAD" =~ ^[a-f0-9]{40}$ ]] && echo "$CR" | valid_run "$CI" "$CA" "$HEAD" ci 2>/dev/null || { log "producer identity invalid; held"; exit 0; }
CARTS=$(G "repos/$REPO/actions/runs/$CI/artifacts?per_page=100") || { log "read producer artifacts failed"; exit 0; }
CBINDING=$(echo "$CARTS" | artifact "$CI" "$CA" "$HEAD" build 2>/dev/null) || { log "producer artifact inventory invalid; held"; exit 0; }
read -r CART _ <<< "$CBINDING"
[ -n "$CART" ] || { log "producer artifact absent; will look again"; continue; }
TAG=$(G "repos/$REPO/tags?per_page=100" | /usr/bin/python3 -I -c 'import json,sys,re
h=sys.argv[1]; tags=[t["name"] for t in json.load(sys.stdin) if t["commit"]["sha"]==h and re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+",t["name"])]
assert len(tags)<=1
print(tags[0] if tags else "")' "$HEAD") || { log "tag inventory invalid; held"; exit 0; }
[ -n "$TAG" ] || { log "attest $AR/$AA: source carries no visible v* tag; will look again"; continue; }
AUD=$(G "repos/$REPO/actions/workflows/dependency-audit.yml/runs?head_sha=$HEAD&status=success&per_page=1") || { log "read audit failed"; exit 0; }
read -r AU UA < <(echo "$AUD" | J workflow_runs.0.id workflow_runs.0.run_attempt | paste -sd' ' -)
[[ "${AU:-}" =~ ^[1-9][0-9]*$ ]] && [[ "${UA:-}" =~ ^[1-9][0-9]*$ ]] || { log "audit absent; will look again"; continue; }
G "repos/$REPO/actions/runs/$AU" | valid_run "$AU" "$UA" "$HEAD" dependency-audit 2>/dev/null || { log "audit changed or invalid; held"; exit 0; }
DONE=$D/sha-$HEAD
[ -f "$DONE.rc" ] && continue   # every completed outcome remains final, including failures
[ ! -e "$DONE.started" ] && [ ! -L "$DONE.started" ] || { log "signing outcome uncertain; held"; exit 0; }
FRESH=$(G "repos/$REPO/commits/master" | J sha) || { log "fresh master read failed"; exit 0; }
[ "$FRESH" = "$M" ] || { log "master moved; no signing intent created"; exit 0; }
CMD=("$RS" --tag "$TAG" --head-sha "$HEAD" --ci-run "$CI" --ci-attempt "$CA" --artifact-id "$CART" --bundle-artifact-id "$BART" \
  --attestor-run "$AR" --attestor-attempt "$AA" --attestor-sha "$AS" --audit-run "$AU" --audit-attempt "$UA")
if [ ! -f "$ST/keychain-allowed" ]; then
  M=$ST/NEEDS-MASON-$TAG
  [ -f "$M" ] || { printf 'NEEDS-MASON %s sha %s\nFirst signing run needs Mason at the Mac for the one Always Allow click.\nRun from his Terminal:\n/bin/bash %s\nThen Masbot: touch %s/keychain-allowed\n' "$TAG" "$HEAD" "${CMD[*]}" "$ST" > "$M"; log "NEEDS-MASON $TAG ${HEAD:0:12} (keychain-allowed absent)"; }
  exit 0
fi
log "START $TAG ${HEAD:0:12} ci=$CI/$CA attest=$AR/$AA audit=$AU/$UA"
: > "$DONE.started"
TMPDIR=/private/tmp /bin/bash "${CMD[@]}" >/dev/null 2>&1; rc=$?
echo $rc > "$DONE.rc"; touch "$D/attest-$AR-$AA.seen"
log "END $TAG ${HEAD:0:12} rc=$rc"
[ $rc = 14 ] && printf 'NEEDS-MASON %s: publish failed (rc=14). Not retried. Inspect the draft release, then rm %s.rc to allow one manual rerun.\n' "$TAG" "$DONE" > "$ST/NEEDS-MASON-$TAG-rc14"
exit 0
done <<< "$CANDIDATES"
exit 0
