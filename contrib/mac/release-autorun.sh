#!/bin/bash
# The live Mac copy is Security-pinned. Changes land only through a Security pin.
# RELEASE-AUTORUN rev2 private selection proposal (GATES v4, Security 2026-11-04). launchd ai.ashlr.release-autorun, every 10 min, OUTSIDE every lane sandbox.
# Finds the newest ready current-source successful attest-ci-build run on ashlrai/phantom, derives all release-sign.sh evidence by GET-only API reads,
# and runs bin/release-sign.sh once per sha when that sha is the target of a v* tag. Never retries after rc=14 (or 0/5/16).
# Until ~/.ashlr-runs/release-sign/keychain-allowed exists (Masbot creates it after Mason clicks Always Allow once), it only writes
# NEEDS-MASON-<tag> with the exact command and starts nothing. Kill switch: ~/.ashlr-runs/RELEASE_AUTORUN_OFF.
# rev2: after selection, each completed successful signing outcome gets a bounded GET-only published-state proof —
# the tag's public release must carry exactly the seven signed desktop assets, its latest.json must bind GitHub's
# recorded asset digests to the signed manifest fields and detached signatures, and while that release is latest
# the public updater endpoint must serve the same feed bytes. feed-<sha>.rc outcomes are final once written:
# 0 verified-live, 21 verified-but-superseded, 22 inconsistent (writes NEEDS-MASON-<tag>-feed). Pending states
# are re-read each tick; this pass never signs, publishes, mutates the release or touches the keychain.
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
