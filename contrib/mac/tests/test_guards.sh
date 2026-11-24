#!/bin/bash
# Guards: AUDIT-TAG-1 hunk stays byte-identical on fixture 742f0504 (AUDIT-TAG-1); only the rev2 retry/skip hunks are added.
# Adjusted from AUDIT-TAG-1's 8 checks for the new base sha. KILL, --selftest, and OFF still fail closed.
set -u; export PATH=/usr/bin:/bin
PKG=$(CDPATH= cd "$(dirname "$0")/.." && pwd); B="$PKG/tests/fixtures/release-autorun-audit-tag-1.sh"; N="$PKG/release-autorun.sh"; fail=0
ok(){ echo "PASS $1"; }; no(){ echo "FAIL $1"; fail=1; }
BASE_SHA=742f050431e5f6c413eb04936905edb9ce07e4403e053090d13470fb829ac8b2
sha256_of(){ /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }
[ "$(sha256_of "$B")" = "$BASE_SHA" ] && ok "base sha is 742f0504" || no "base sha $(sha256_of "$B")"
cmp -s <(sed -n '198,200p' "$B") <(sed -n '202,204p' "$N") && ok "AUDIT-TAG-1 hunk byte-identical in base 198-200 and payload 202-204" || no "audit hunk mismatch"
HUNKS=$(diff "$B" "$N" | grep '^[0-9]')
EXP='7c7,10
159a163
202,203c206,225
230c252
232,233c254,260
235c262,264
265a295'
[ "$HUNKS" = "$EXP" ] && ok "exactly the seven rev2 hunks on fixture 742f0504 (AUDIT-TAG-1)" || { no "hunk list"; printf 'got:\n%s\nwant:\n%s\n' "$HUNKS" "$EXP"; }
# Lines 17-45 of the base (selftest gating 17-22, REALHOME 23-35, OFF 38, KILL 41-45) are shifted by +3 in the payload (header comments).
cmp -s <(sed -n '17,45p' "$B") <(sed -n '20,48p' "$N") && ok "selftest/REALHOME/OFF/KILL lines byte-identical (base 17-45 == payload 20-48)" || no "guard-region drift"
T=$(mktemp -d /tmp/ra-repin-rev3-guard.XXXXXX); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/stubs" "$T/bin" "$T/kill-dir" "$T/release-sign/autorun"; echo 'while (<STDIN>) { print; }' > "$T/bin/scrub.pl"
for s in gh curl release-sign.sh; do printf '#!/bin/bash\necho "%s $*" >> "%s/called"\nexit 1\n' "$s" "$T/stubs" > "$T/stubs/$s"; chmod 700 "$T/stubs/$s"; done
E=(RA_ROOT_SELFTEST="$T" RA_GH_SELFTEST="$T/stubs/gh" RA_RS_SELFTEST="$T/stubs/release-sign.sh" RA_CURL_SELFTEST="$T/stubs/curl" RA_KILL_SELFTEST="$T/kill-dir/KILL")
env -i PATH=/usr/bin:/bin "${E[@]}" /bin/bash "$N" >/dev/null 2>&1; rc=$?
[ $rc = 2 ] && [ ! -f "$T/stubs/called" ] && ok "RA_* without --selftest: rc=2, no stub called" || no "selftest gating rc=$rc"
env -i PATH=/usr/bin:/bin /bin/bash "$N" --bogus >/dev/null 2>&1; [ $? = 2 ] && ok "unknown arg rc=2" || no "argv"
touch "$T/kill-dir/KILL"; env -i PATH=/usr/bin:/bin "${E[@]}" /bin/bash "$N" --selftest; rc=$?
[ $rc = 0 ] && [ ! -f "$T/stubs/called" ] && grep -q 'fleet KILL present' "$T/release-sign/autorun/autorun.log" && ok "KILL: rc=0, logged, no network" || no "KILL rc=$rc"
rm -f "$T/kill-dir/KILL"; touch "$T/RELEASE_AUTORUN_OFF"; env -i PATH=/usr/bin:/bin "${E[@]}" /bin/bash "$N" --selftest; rc=$?
[ $rc = 0 ] && [ ! -f "$T/stubs/called" ] && ok "RELEASE_AUTORUN_OFF: rc=0, no network" || no "OFF rc=$rc"
echo "guard tests exit=$fail"; exit $fail
