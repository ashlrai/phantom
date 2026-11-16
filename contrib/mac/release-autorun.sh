#!/bin/bash
# RELEASE-AUTORUN rev2b-sec (STANDING-RELEASE-AUTHORITY rev1b + ANCESTOR-sec, Security 2026-11-09; base: #4135 + #4190).
# ANCESTOR-sec: attestor sha must equal the peeled release-tag sha; head_branch must be that tag or master-with-sha==master.
# Ancestor-of-master alone is not enough (replay). Compare is URL-encoded, repo-bound, fail-closed on truncation.
# launchd ai.ashlr.release-autorun, every 10 min, OUTSIDE every lane sandbox. Cadence under the standing approval needs no per-release Mason.
# Finds the newest ready current-source successful attest-ci-build run on ashlrai/phantom, derives all release-sign.sh evidence by GET-only API reads,
# and runs bin/release-sign.sh when that sha is the target of a v* tag.
# Signer stdout and stderr are scrubbed into sha-<sha>.log.
# rc 0, 5 and 16 stay final. Any other rc is retried up to 3 times, then rc 14 writes NEEDS-MASON.
# v3.30.34 is superseded by the next version: this pass skips it and never edits, publishes, deletes, or moves that draft or tag.
# Until ~/.ashlr-runs/release-sign/keychain-allowed exists (Masbot creates it after Mason clicks Always Allow once), it only writes
# NEEDS-MASON-<tag> with the exact command and starts nothing. Kill switches: ~/.ashlr/KILL (fleet) and ~/.ashlr-runs/RELEASE_AUTORUN_OFF. Either stops before any network.
# rev2: after selection, each completed successful signing outcome gets a bounded GET-only published-state proof  -
# the tag's public release must carry exactly the seven signed desktop assets, its latest.json must bind GitHub's
# recorded asset digests to the signed manifest fields and detached signatures, and while that release is latest
# the public updater endpoint must serve the same feed bytes. feed-<sha>.rc outcomes are final once written:
# 0 verified-live, 21 verified-but-superseded, 22 inconsistent (writes NEEDS-MASON-<tag>-feed). Pending states
# are re-read each tick; this pass never signs, publishes, mutates the release or touches the keychain.
set -u; set +x; umask 077
# RQ-SEC-REALHOME-1 (d): RA_*_SELFTEST overrides are honored ONLY with --selftest (same rule as release-sign.sh:28).
# Real mode (launchd, no argv) refuses any of them before any network, so a LaunchAgent env cannot swap KILL, gh, curl, root or release-sign.
RA_SELFTEST=0; case "${1:-}" in --selftest) RA_SELFTEST=1; shift;; "") ;; *) echo "usage: release-autorun.sh [--selftest]" >&2; exit 2;; esac
[ "$#" -eq 0 ] || { echo "usage: release-autorun.sh [--selftest]" >&2; exit 2; }
if [ $RA_SELFTEST = 0 ]; then for v in RA_ROOT_SELFTEST RA_GH_SELFTEST RA_RS_SELFTEST RA_KILL_SELFTEST RA_CURL_SELFTEST; do
  [ -z "${!v:-}" ] || { echo "usage: $v override is selftest-only" >&2; exit 2; }; done; fi
# RQ-SEC-REALHOME-1 (e) FAIL-CLOSED: account home from dscl NFSHomeDirectory (space-safe), then dscl retry, then pwd.getpwuid; never keep a caller-moved $HOME.
_RH=$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory 2>/dev/null | /usr/bin/sed -n 's/^NFSHomeDirectory: //p')
case "$_RH" in /*) [ -d "$_RH" ] || _RH=;; *) _RH=;; esac
if [ -z "$_RH" ]; then
  _RH=$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory 2>/dev/null | /usr/bin/sed -n 's/^NFSHomeDirectory: //p')
  case "$_RH" in /*) [ -d "$_RH" ] || _RH=;; *) _RH=;; esac
fi
if [ -z "$_RH" ]; then
  _RH=$(/usr/bin/python3 -I -c 'import pwd,os;print(pwd.getpwuid(os.getuid()).pw_dir)' 2>/dev/null)
  case "$_RH" in /*) [ -d "$_RH" ] || _RH=;; *) _RH=;; esac
fi
if [ -z "$_RH" ]; then echo "realhome: unresolved account home; fleet KILL engaged (fail closed)" >&2; exit 0; fi
export HOME="$_RH"; unset _RH
REPO=ashlrai/phantom; R=${RA_ROOT_SELFTEST:-$HOME/.ashlr-runs}; ST=$R/release-sign; D=$ST/autorun
GH=${RA_GH_SELFTEST:-/opt/homebrew/bin/gh}; RS=${RA_RS_SELFTEST:-$R/bin/release-sign.sh}; SCRUB=$R/bin/scrub.pl
[ -f $R/RELEASE_AUTORUN_OFF ] && exit 0
mkdir -p -m 700 "$ST" "$D"; L=$D/autorun.log
log(){ echo "$(date '+%F %T') $*" | /usr/bin/perl "$SCRUB" >> "$L"; }
# Fleet KILL (~/.ashlr/KILL), same sentinel as ashlr stop. Present or unreadable dir fails closed before any network.
KILL=${RA_KILL_SELFTEST:-$HOME/.ashlr/KILL}
if [ -L "$KILL" ] || [ -e "$KILL" ]; then log "fleet KILL present; release train stopped"; exit 0; fi
KILL_DIR=$(dirname "$KILL")
if [ -e "$KILL_DIR" ] && [ ! -r "$KILL_DIR" ]; then log "fleet KILL directory unreadable; fail closed"; exit 0; fi
mkdir "$D/lock" 2>/dev/null || exit 0; trap 'rmdir "$D/lock" 2>/dev/null' EXIT
[ -d "$ST/lock" ] && { log "release-sign running, skip"; exit 0; }
G(){ "$GH" api --hostname github.com -H 'Accept: application/vnd.github+json' "$1"; }   # GET only
urlenc(){ /usr/bin/python3 -I -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
# base is identical to or a strict ancestor of head. Fail closed on bad sha, wrong repo, truncation, pagination.
compare_ancestor(){
  local b="$1" h="$2" js
  [[ "$b" =~ ^[a-f0-9]{40}$ ]] && [[ "$h" =~ ^[a-f0-9]{40}$ ]] || return 1
  [ "$b" = "$h" ] && return 0
  js=$(G "repos/$REPO/compare/$(urlenc "$b")...$(urlenc "$h")") || return 1
  echo "$js" | /usr/bin/python3 -I -c '
import json,sys,re
r=json.load(sys.stdin)
url=r.get("url") or ""
if not re.search(r"/repos/ashlrai/phantom/compare/", url):
    sys.exit(1)
st=r.get("status")
if st not in ("ahead","identical"):
    sys.exit(1)
if r.get("truncated") is True:
    sys.exit(1)
commits=r.get("commits")
tc=r.get("total_commits")
if isinstance(commits,list) and isinstance(tc,int) and tc>len(commits):
    sys.exit(1)
'
}
peel_tag_sha(){ # $1 tag name (must already match ^vX.Y.Z$); prints peeled 40-hex or fails
  local tag="$1" REF OT obj
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  REF=$(G "repos/$REPO/git/ref/tags/$(urlenc "$tag")") || return 1
  read -r OT obj < <(echo "$REF" | J object.type object.sha | paste -sd' ' -)
  if [ "$OT" = tag ]; then
    [[ "$obj" =~ ^[a-f0-9]{40}$ ]] || return 1
    obj=$(G "repos/$REPO/git/tags/$(urlenc "$obj")" | J object.sha) || return 1
  elif [ "$OT" != commit ]; then
    return 1
  fi
  [[ "$obj" =~ ^[a-f0-9]{40}$ ]] || return 1
  printf '%s\n' "$obj"
}
newer(){ local a b i; IFS=. read -r -a a <<< "${1#v}"; IFS=. read -r -a b <<< "${2#v}"; for i in 0 1 2; do [ "$((10#${a[i]:-0}))" -gt "$((10#${b[i]:-0}))" ] && return 0; [ "$((10#${a[i]:-0}))" -lt "$((10#${b[i]:-0}))" ] && return 1; done; return 1; }
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
r=json.load(sys.stdin); run,attempt,sha,workflow=sys.argv[1:5]
assert type(r.get("id")) is int and r["id"]==int(run) and type(r.get("run_attempt")) is int and r["run_attempt"]==int(attempt)
assert r.get("path")==".github/workflows/"+workflow+".yml" and r.get("head_sha")==sha and r.get("head_branch")==(sys.argv[5] if len(sys.argv)>5 else "master")
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
 assert a.get("path")==".github/workflows/attest-ci-build.yml" and (a.get("head_branch")=="master" or re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+",a.get("head_branch") or "")) and a.get("status")=="completed" and a.get("conclusion")=="success" and re.fullmatch(r"[a-f0-9]{40}",a.get("head_sha",""))
 for key in ("repository","head_repository"):
  assert a[key].get("id")==1263526319 and a[key].get("full_name")=="ashlrai/phantom"
 print(a["id"],a["run_attempt"],a["head_sha"],a["head_branch"])') || { log "attest run inventory invalid"; exit 0; }
# Inventory already required head_branch master or vX.Y.Z (rejects refs/heads/vX.Y.Z and non-release tags).
while read -r AR AA AS ABR; do
[ -n "${AR:-}" ] || continue
[[ "$AS" =~ ^[a-f0-9]{40}$ ]] || continue
# head_branch from inventory: exact master or exact vX.Y.Z (no refs/heads/*).
if [ "$ABR" = master ]; then
  [ "$AS" = "$M" ] || { log "attest $AR/$AA head_branch=master but sha is not current master; skipped"; continue; }
elif [[ "$ABR" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  compare_ancestor "$AS" "$M" || { log "attest $AR/$AA not an ancestor of master (diverged/behind/truncated/unreadable); skipped"; continue; }
else
  log "attest $AR/$AA head_branch rejected; skipped"; continue
fi
[ -f "$D/attest-$AR-$AA.seen" ] && continue
G "repos/$REPO/actions/runs/$AR" | valid_run "$AR" "$AA" "$AS" attest-ci-build "$ABR" 2>/dev/null || { log "attest $AR/$AA changed or invalid; held"; exit 0; }
BA=$(G "repos/$REPO/actions/runs/$AR/artifacts?per_page=100") || { log "read attest artifacts failed"; exit 0; }
BINDING=$(echo "$BA" | artifact "$AR" "$AA" "$AS" attested 2>/dev/null) || { log "attest $AR/$AA artifact inventory invalid; held"; exit 0; }
read -r BART BNAME <<< "$BINDING"
[ -n "${BART:-}" ] || { log "attest $AR/$AA: no current-attempt handoff yet"; continue; }
IFS=- read -r _ _ CI CA AR2 AA2 <<< "$BNAME"
[ "$AR2" = "$AR" ] && [ "$AA2" = "$AA" ] || { log "attest $AR/$AA handoff mismatch; held"; exit 0; }
CR=$(G "repos/$REPO/actions/runs/$CI/attempts/$CA") || { log "read producer failed"; exit 0; }
HEAD=$(echo "$CR" | J head_sha)
[[ "$HEAD" =~ ^[a-f0-9]{40}$ ]] || { log "producer identity invalid; held"; exit 0; }
TAG=$(G "repos/$REPO/tags?per_page=100" | /usr/bin/python3 -I -c 'import json,sys,re
h=sys.argv[1]; tags=[t["name"] for t in json.load(sys.stdin) if t["commit"]["sha"]==h and re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+",t["name"])]
assert len(tags)<=1
print(tags[0] if tags else "")' "$HEAD") || { log "tag inventory invalid; held"; exit 0; }
[ -n "$TAG" ] || { log "attest $AR/$AA: source carries no visible v* tag; will look again"; continue; }
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { log "attest $AR/$AA: tag name rejected"; continue; }
if [ "$TAG" = v3.30.34 ]; then log "skip v3.30.34 superseded; not edited, published, deleted, or moved"; continue; fi
PEEL=$(peel_tag_sha "$TAG") || { log "attest $AR/$AA: tag peel failed; held"; exit 0; }
[ "$PEEL" = "$HEAD" ] && [ "$AS" = "$HEAD" ] || { log "attest $AR/$AA: attestor/producer sha is not the peeled tag sha; skipped"; continue; }
if [ "$ABR" = "$TAG" ]; then
  :
elif [ "$ABR" = master ] && [ "$AS" = "$M" ]; then
  :
else
  log "attest $AR/$AA: head_branch $ABR is not $TAG or master-with-current-sha; skipped"; continue
fi
LAT=$(G "repos/$REPO/releases/latest" | J tag_name) || { log "last released version unreadable; held"; exit 0; }
[[ "$LAT" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { log "last released tag invalid; held"; exit 0; }
newer "$TAG" "$LAT" || { log "tag $TAG is not strictly newer than last released $LAT; skipped"; continue; }
for _mk in "$ST/last-released-tag" "$ST/release-once-version"; do
  if [ -L "$_mk" ] || [ -e "$_mk" ]; then
    [ -f "$_mk" ] && [ ! -L "$_mk" ] || { log "release-once/last-released marker unreadable; held"; exit 0; }
    _mv=$(cat "$_mk" 2>/dev/null || true)
    [[ "$_mv" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { log "release-once/last-released marker invalid; held"; exit 0; }
    newer "$TAG" "$_mv" || { log "tag $TAG is not strictly newer than release-once marker $_mv; skipped"; continue 2; }
  fi
done
unset _mk _mv
# Producer may be master push CI, or a tag-ref CI only when the tagged commit is an ancestor of (or equal to) master.
if echo "$CR" | valid_run "$CI" "$CA" "$HEAD" ci 2>/dev/null; then
  :
elif echo "$CR" | valid_run "$CI" "$CA" "$HEAD" ci "$TAG" 2>/dev/null; then
  if [ "$HEAD" != "$M" ]; then
    compare_ancestor "$HEAD" "$M" || { log "tag-ref producer sha is not an ancestor of master (or compare unreadable/truncated); held"; continue; }
  fi
else
  log "producer identity invalid; held"; exit 0
fi
CARTS=$(G "repos/$REPO/actions/runs/$CI/artifacts?per_page=100") || { log "read producer artifacts failed"; exit 0; }
CBINDING=$(echo "$CARTS" | artifact "$CI" "$CA" "$HEAD" build 2>/dev/null) || { log "producer artifact inventory invalid; held"; exit 0; }
read -r CART _ <<< "$CBINDING"
[ -n "$CART" ] || { log "producer artifact absent; will look again"; continue; }
AUD=$(G "repos/$REPO/actions/workflows/dependency-audit.yml/runs?head_sha=$HEAD&status=success&per_page=1") || { log "read audit failed"; exit 0; }
read -r AU UA < <(echo "$AUD" | J workflow_runs.0.id workflow_runs.0.run_attempt | paste -sd' ' -)
[[ "${AU:-}" =~ ^[1-9][0-9]*$ ]] && [[ "${UA:-}" =~ ^[1-9][0-9]*$ ]] || { log "audit absent; will look again"; continue; }
# AUDIT-TAG-1: audit run on master, or on exactly $TAG (peeled tag sha == HEAD, ancestor of master, fail closed); event push|schedule|workflow_dispatch only.
AUJ=$(G "repos/$REPO/actions/runs/$AU") && echo "$AUJ" | J event 2>/dev/null | /usr/bin/grep -qxE 'push|schedule|workflow_dispatch' || { log "audit changed or invalid; held"; exit 0; }
{ echo "$AUJ" | valid_run "$AU" "$UA" "$HEAD" dependency-audit 2>/dev/null || { echo "$AUJ" | valid_run "$AU" "$UA" "$HEAD" dependency-audit "$TAG" 2>/dev/null && { [ "$HEAD" = "$M" ] || compare_ancestor "$HEAD" "$M"; }; }; } || { log "audit changed or invalid; held"; exit 0; }
DONE=$D/sha-$HEAD
TRIES=$DONE.tries
if [ -f "$DONE.rc" ]; then
  prev=$(tr -d '[:space:]' < "$DONE.rc")
  case "$prev" in
    0|5|16) continue ;;
  esac
  n=1
  if [ -f "$TRIES" ]; then n=$(tr -d '[:space:]' < "$TRIES"); fi
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || n=1
  if [ "$n" -ge 3 ]; then
    log "retry exhausted $TAG ${HEAD:0:12} rc=$prev"
    if [ "$prev" = 14 ] && [ ! -f "$ST/NEEDS-MASON-$TAG-rc14" ]; then
      printf 'NEEDS-MASON %s: publish failed (rc=14) after 3 attempts. Inspect the draft release, then rm %s.rc and %s.tries to allow another run.\n' "$TAG" "$DONE" "$DONE" > "$ST/NEEDS-MASON-$TAG-rc14"
    fi
    continue
  fi
else
  [ ! -e "$DONE.started" ] && [ ! -L "$DONE.started" ] || { log "signing outcome uncertain; held"; exit 0; }
  n=0
fi
FRESH=$(G "repos/$REPO/commits/master" | J sha) || { log "fresh master read failed"; exit 0; }
[[ "$FRESH" =~ ^[a-f0-9]{40}$ ]] || { log "fresh master sha invalid; no signing intent created"; exit 0; }
# TOCTOU: re-peel the tag; attestor sha must still equal the peeled tag. Master attestations cannot drift.
PEEL2=$(peel_tag_sha "$TAG") || { log "tag peel failed before signing intent; held"; exit 0; }
[ "$PEEL2" = "$HEAD" ] && [ "$PEEL2" = "$AS" ] || { log "tag moved before signing intent; no signing intent created"; exit 0; }
if [ "$ABR" = master ]; then
  [ "$FRESH" = "$AS" ] || { log "master moved after a master attestation; no signing intent created"; exit 0; }
else
  compare_ancestor "$AS" "$FRESH" || { log "attestor/tag sha no longer an ancestor of master; no signing intent created"; exit 0; }
fi
# Cadence rate limit (addendum rule 2): skip if last successful publish was under 60 minutes ago.
LAST=$ST/last-cadence-ok
if [ -f "$LAST" ] && [ ! -L "$LAST" ]; then
  now=$(date +%s); prev=$(cat "$LAST" 2>/dev/null || echo 0)
  if [[ "$prev" =~ ^[0-9]+$ ]]; then
    age=$((now-prev)); [ "$age" -ge 3600 ] || { log "cadence rate limit: last publish ${age}s ago; skip"; exit 0; }
  fi
fi
[ -f "$ST/standing-authority" ] && [ ! -L "$ST/standing-authority" ] && grep -q 'STANDING-RELEASE-AUTHORITY rev1' "$ST/standing-authority" || { log "standing-authority marker absent; skip"; exit 0; }
CMD=("$RS" --tag "$TAG" --head-sha "$HEAD" --ci-run "$CI" --ci-attempt "$CA" --artifact-id "$CART" --bundle-artifact-id "$BART" \
  --attestor-run "$AR" --attestor-attempt "$AA" --attestor-sha "$AS" --audit-run "$AU" --audit-attempt "$UA")
if [ ! -f "$ST/keychain-allowed" ]; then
  M=$ST/NEEDS-MASON-$TAG
  [ -f "$M" ] || { printf 'NEEDS-MASON %s sha %s\nStanding authority is installed; first signing still needs the one Always Allow click for Ashlr Local.\nRun from his Terminal:\n/bin/bash %s\nThen Masbot: touch %s/keychain-allowed\n' "$TAG" "$HEAD" "${CMD[*]}" "$ST" > "$M"; log "NEEDS-MASON $TAG ${HEAD:0:12} (keychain-allowed absent)"; }
  exit 0
fi
log "START $TAG ${HEAD:0:12} ci=$CI/$CA attest=$AR/$AA audit=$AU/$UA attempt=$((n+1))"
: > "$DONE.started"
LOGF=$D/sha-$HEAD.log
set -o pipefail
TMPDIR=/private/tmp /bin/bash "${CMD[@]}" 2>&1 | /usr/bin/perl "$SCRUB" >> "$LOGF"
rc=$?
set +o pipefail
echo $rc > "$DONE.rc"; echo $((n+1)) > "$TRIES"
if [ "$rc" = 0 ] || [ "$rc" = 5 ] || [ "$rc" = 16 ] || [ "$((n+1))" -ge 3 ]; then touch "$D/attest-$AR-$AA.seen"; fi
log "END $TAG ${HEAD:0:12} rc=$rc"
if [ "$rc" = 14 ] && [ "$((n+1))" -ge 3 ]; then
  printf 'NEEDS-MASON %s: publish failed (rc=14) after 3 attempts. Inspect the draft release, then rm %s.rc and %s.tries to allow another run.\n' "$TAG" "$DONE" "$DONE" > "$ST/NEEDS-MASON-$TAG-rc14"
fi
exit 0
done <<< "$CANDIDATES"
# rev2 update-channel verification: pending completed signing outcomes only.
PENDING=0
for RC in "$D"/sha-*.rc; do
  [ -e "$RC" ] || [ -L "$RC" ] || continue
  [ "$(cat "$RC" 2>/dev/null)" = "0" ] || continue
  FS=${RC##*/}; FS=${FS#sha-}; FS=${FS%.rc}
  [[ "$FS" =~ ^[a-f0-9]{40}$ ]] && [ ! -f "$D/feed-$FS.rc" ] && PENDING=1 && break
done
if [ "$PENDING" = 1 ]; then
rm -f "$D"/feed-*.feed "$D"/feed-*.manifest "$D"/feed-*.msig "$D"/feed-*.appsig "$D"/feed-*.endpoint "$D"/feed-*.rel.json "$D"/feed-*.assets.json
TAGS=$(G "repos/$REPO/tags?per_page=100") || { log "feed: tag inventory unavailable"; exit 0; }
CURL=${RA_CURL_SELFTEST:-/usr/bin/curl}
GA(){ "$GH" api --hostname github.com -H 'Accept: application/octet-stream' "$1"; }
newer(){ local a b i; IFS=. read -r -a a <<< "${1#v}"; IFS=. read -r -a b <<< "${2#v}"; for i in 0 1 2; do [ "$((10#${a[i]:-0}))" -gt "$((10#${b[i]:-0}))" ] && return 0; [ "$((10#${a[i]:-0}))" -lt "$((10#${b[i]:-0}))" ] && return 1; done; return 1; }
feedrc(){ printf '{"schemaVersion":1,"kind":"desktop-update-channel-check","state":"%s","sha":"%s","tag":"%s","releaseId":%s,"latestTag":"%s","endpointHttp":%s,"feedSha256":"%s","manifestSha256":"%s","checkedAt":"%s"}\n' "$1" "$FSHA" "$FTAG" "$RELID" "${LTAG:-}" "${CODE:-null}" "$FDIG" "$MDIG" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$FMARK.json"; }
feedfail(){ local code=$1; printf '{"schemaVersion":1,"kind":"desktop-update-channel-check","state":"failed","reason":"%s","sha":"%s","tag":"%s","checkedAt":"%s"}\n' "$code" "$FSHA" "$FTAG" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$FMARK.json"; printf 'NEEDS-MASON %s: update-channel verification failed for signed sha %s (%s). Not retried. Inspect the published release, then rm %s.rc to allow one manual recheck.\n' "$FTAG" "$FSHA" "$code" "$FMARK" > "$ST/NEEDS-MASON-$FTAG-feed"; echo 22 > "$FMARK.rc"; log "feed $FTAG ${FSHA:0:12} FAILED: $code"; }
for RC in "$D"/sha-*.rc; do
  [ -e "$RC" ] || [ -L "$RC" ] || continue
  [ "$(cat "$RC" 2>/dev/null)" = "0" ] || continue
  FSHA=${RC##*/}; FSHA=${FSHA#sha-}; FSHA=${FSHA%.rc}
  [[ "$FSHA" =~ ^[a-f0-9]{40}$ ]] || continue
  FMARK=$D/feed-$FSHA
  [ -f "$FMARK.rc" ] && continue   # every completed feed outcome remains final
  FTAG=$(echo "$TAGS" | /usr/bin/python3 -I -c 'import json,sys,re
h=sys.argv[1]; tags=[t["name"] for t in json.load(sys.stdin) if t["commit"]["sha"]==h and re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+",t["name"])]
assert len(tags)<=1
print(tags[0] if tags else "")' "$FSHA" 2>/dev/null) || { log "feed ${FSHA:0:12}: tag inventory invalid; will look again"; continue; }
  [ -n "$FTAG" ] || continue   # the signed sha carries no visible v* tag; look again
  if [ "$FTAG" = v3.30.34 ]; then log "skip v3.30.34 feed; not edited, published, deleted, or moved"; continue; fi
  FV=${FTAG#v}
  REL=$(G "repos/$REPO/releases/tags/$FTAG") || { log "feed $FTAG ${FSHA:0:12}: release not public yet; will look again"; continue; }
  RELF=$D/feed-$FSHA.rel.json; printf '%s' "$REL" > "$RELF"
  RELID=$(echo "$REL" | /usr/bin/python3 -I -c 'import json,sys
r=json.load(sys.stdin); tag,sha=sys.argv[1:]
assert type(r.get("id")) is int and r["id"]>0 and r.get("tag_name")==tag
assert r.get("draft") is False and r.get("prerelease") is False and r.get("target_commitish")==sha
print(r["id"])' "$FTAG" "$FSHA" 2>/dev/null) || { feedfail release-inconsistent; rm -f "$RELF"; continue; }
  ASSETS=$(G "repos/$REPO/releases/$RELID/assets?per_page=100") || { log "feed $FTAG: asset inventory unavailable; will look again"; rm -f "$RELF"; continue; }
  ASTF=$D/feed-$FSHA.assets.json; printf '%s' "$ASSETS" > "$ASTF"
  PLAN=$(echo "$ASSETS" | /usr/bin/python3 -I -c 'import json,sys,re
version=sys.argv[1]; rows=json.load(sys.stdin)
assert isinstance(rows,list) and len(rows)<=100
assert all(type(a.get("id")) is int and a["id"]>0 and isinstance(a.get("name"),str) for a in rows)
assert len({a["id"] for a in rows})==len(rows)
want={"manifest.json","manifest.json.sig","latest.json","Phantom_"+version+"_aarch64.app.tar.gz","Phantom_"+version+"_aarch64.app.tar.gz.sig","ashlr-phantom-"+version+".tgz","ashlr-phantom-"+version+".tgz.sig"}
by={a["name"]:a for a in rows}
assert set(by)==want
pending=False
for a in rows:
 assert a.get("state")=="uploaded" and type(a.get("size")) is int and a["size"]>0
 if not re.fullmatch(r"sha256:[a-f0-9]{64}",a.get("digest") or ""): pending=True
if pending: print("PENDING"); sys.exit(3)
for k in ("latest.json","manifest.json","manifest.json.sig","Phantom_"+version+"_aarch64.app.tar.gz.sig"): print(by[k]["id"])' "$FV" 2>/dev/null); prc=$?
  if [ $prc != 0 ]; then
    if [ "$PLAN" = PENDING ]; then log "feed $FTAG: asset digests still populating; will look again"; else feedfail asset-set-incomplete; fi
    rm -f "$RELF" "$ASTF"; continue
  fi
  IDS=(); while read -r i; do IDS+=("$i"); done <<< "$PLAN"
  [ "${#IDS[@]}" = 4 ] || { feedfail asset-plan-malformed; rm -f "$RELF" "$ASTF"; continue; }
  FBODY=$D/feed-$FSHA.feed; MBODY=$D/feed-$FSHA.manifest; SBODY=$D/feed-$FSHA.msig; ABODY=$D/feed-$FSHA.appsig; EBODY=$D/feed-$FSHA.endpoint
  GA "repos/$REPO/releases/assets/${IDS[0]}" > "$FBODY" && GA "repos/$REPO/releases/assets/${IDS[1]}" > "$MBODY" && GA "repos/$REPO/releases/assets/${IDS[2]}" > "$SBODY" && GA "repos/$REPO/releases/assets/${IDS[3]}" > "$ABODY" || { log "feed $FTAG: signed asset body read failed; will look again"; rm -f "$RELF" "$ASTF" "$FBODY" "$MBODY" "$SBODY" "$ABODY"; continue; }
  REC=$(/usr/bin/python3 -I -c 'import json,sys,re,hashlib
tag,sha,version,relpath,assetspath,feedpath,manifestpath,sigpath,appsigpath=sys.argv[1:10]
def rd(p,m):
 b=open(p,"rb").read(); assert len(b)<=m; return b
rel=json.loads(rd(relpath,1<<20))
assert type(rel.get("id")) is int and rel["id"]>0 and rel.get("tag_name")==tag
assert rel.get("draft") is False and rel.get("prerelease") is False and rel.get("target_commitish")==sha
rows=json.loads(rd(assetspath,4<<20))
assert isinstance(rows,list) and len(rows)<=100
assert all(type(a.get("id")) is int and a["id"]>0 and isinstance(a.get("name"),str) for a in rows)
assert len({a["id"] for a in rows})==len(rows)
want={"manifest.json","manifest.json.sig","latest.json","Phantom_"+version+"_aarch64.app.tar.gz","Phantom_"+version+"_aarch64.app.tar.gz.sig","ashlr-phantom-"+version+".tgz","ashlr-phantom-"+version+".tgz.sig"}
by={a["name"]:a for a in rows}
assert set(by)==want
for a in rows:
 assert a.get("state")=="uploaded" and type(a.get("size")) is int and a["size"]>0 and re.fullmatch(r"sha256:[a-f0-9]{64}",a.get("digest") or "")
feed=rd(feedpath,128*1024); manifest=rd(manifestpath,64*1024); sig=rd(sigpath,8192); appsig=rd(appsigpath,8192)
for name,b in (("latest.json",feed),("manifest.json",manifest),("manifest.json.sig",sig),("Phantom_"+version+"_aarch64.app.tar.gz.sig",appsig)):
 assert hashlib.sha256(b).hexdigest()==by[name]["digest"][7:]
f=json.loads(feed.decode("utf8"))
assert isinstance(f,dict) and f.get("version")==version
base="https://github.com/ashlrai/phantom/releases/download/v"+version+"/"
plat=f["platforms"]["darwin-aarch64"]
assert plat["url"]==base+"Phantom_"+version+"_aarch64.app.tar.gz"
assert plat["signature"]==appsig.decode("utf8")
env=f["phantom"]
assert env["manifestText"]==manifest.decode("utf8") and env["signature"]==sig.decode("utf8")
m=json.loads(manifest.decode("utf8"))
assert m["version"]==version and m["kind"]=="phantom-paired-release" and m["source"]["revision"]==sha
assert m["app"]["filename"]=="Phantom_"+version+"_aarch64.app.tar.gz" and m["app"]["url"]==plat["url"] and m["app"]["sha256"]==by["Phantom_"+version+"_aarch64.app.tar.gz"]["digest"][7:]
assert m["cli"]["filename"]=="ashlr-phantom-"+version+".tgz" and m["cli"]["url"]==base+"ashlr-phantom-"+version+".tgz" and m["cli"]["sha256"]==by["ashlr-phantom-"+version+".tgz"]["digest"][7:]
print(hashlib.sha256(feed).hexdigest(),hashlib.sha256(manifest).hexdigest())' "$FTAG" "$FSHA" "$FV" "$RELF" "$ASTF" "$FBODY" "$MBODY" "$SBODY" "$ABODY" 2>/dev/null); vrc=$?
  if [ $vrc != 0 ]; then
    if [ $vrc = 3 ]; then log "feed $FTAG: awaiting consistent publication; will look again"; else feedfail binding-failed; fi
    rm -f "$RELF" "$ASTF" "$FBODY" "$MBODY" "$SBODY" "$ABODY"; continue
  fi
  read -r FDIG MDIG <<< "$REC"
  LATEST=$(G "repos/$REPO/releases/latest") || { log "feed $FTAG: latest release unreadable; will look again"; rm -f "$RELF" "$ASTF" "$FBODY" "$MBODY" "$SBODY" "$ABODY"; continue; }
  LTAG=$(echo "$LATEST" | J tag_name 2>/dev/null) || { log "feed $FTAG: latest identity invalid; will look again"; rm -f "$RELF" "$ASTF" "$FBODY" "$MBODY" "$SBODY" "$ABODY"; continue; }
  if [ "$LTAG" != "$FTAG" ]; then
    if [[ "$LTAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && newer "$LTAG" "$FTAG"; then
      CODE= feedrc superseded; echo 21 > "$FMARK.rc"
      log "feed $FTAG ${FSHA:0:12}: complete set verified; superseded as latest by $LTAG"
    else log "feed $FTAG ${FSHA:0:12}: latest is ${LTAG:-unknown}"; feedfail latest-mismatch; fi
  else
    rm -f "$EBODY"
    CODE=$("$CURL" -sS -L --max-time 15 -o "$EBODY" -w '%{http_code}' "https://github.com/$REPO/releases/latest/download/latest.json" 2>/dev/null) || CODE=''
    if [ "$CODE" = "200" ] && cmp -s "$EBODY" "$FBODY"; then
      feedrc verified-live; echo 0 > "$FMARK.rc"
      log "FEED-OK $FTAG ${FSHA:0:12} release=$RELID endpoint=200"
    elif [ "$CODE" != "200" ]; then
      log "feed $FTAG: updater endpoint returned HTTP ${CODE:-unavailable}; will look again"
    else feedfail endpoint-mismatch; fi
  fi
  rm -f "$RELF" "$ASTF" "$FBODY" "$MBODY" "$SBODY" "$ABODY" "$EBODY"
done
fi
exit 0
