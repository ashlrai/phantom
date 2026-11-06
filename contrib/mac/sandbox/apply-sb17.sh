#!/bin/sh
# apply-sb17.sh — install the SB-17 SANDBOX-DENY-OSA tighten into the 5 lane
# profiles + the codex-local launch.sh pin. Masbot-run, outside any lane.
# Idempotent: a file already at its post state is skipped, so this composes
# with `patch -p2 < sandbox-deny-osa.diff` (patch may move some or all files).
# Hard-stops (exit 9) on any sha/content it does not recognise. Rev1 — RQ-SBDENYLSDQ7.
set -u
R=${ASHLR_RUNS_ROOT:-$HOME/.ashlr-runs}
B=${ASHLR_RUNS_BIN:-$R/bin}
S=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
E=$(date +%s)

sha(){ shasum -a 256 "$1"|cut -c1-64; }
want(){ [ -f "$1" ] && [ "$(sha "$1")" = "$2" ] || { echo "PRECOND FAIL $1 got=$(sha "$1" 2>/dev/null) want=$2"; exit 9; }; }
die(){ echo "PRECOND FAIL $1"; exit 9; }
has_block(){ grep -Fq 'com.apple.coreservices.launchservicesd' "$1" && grep -Fq '(deny appleevent-send)' "$1"; }

# --- expected pre/post shas (pre-SB17 live state; rev3 output, sha-verified
# against live bin by Masbot 2026-10-27 — terminals/1336.txt) ---
PRE_A=002278b0c55fee509a27787c11fd4818c2395d1ccb1d9edb9c095966647b82d1
POST_A=ed8fc729c73bbcfa77e5286a6ce7af518acc1d99b08f4d779b6d4e3f338a9003
PRE_C=56fe451c11a8ec28bfa726fd65a456d79769de5c2ac613df8f1b3dd041f70f2b
POST_C=a007a4074c7976538f28efbbaa1017d154702bb0262bc9b6b48d9e7d89f0d7f7
PRE_P=d3f5658f1c24d1e4ba0b27d51bec2833c9e0acf07025c5608e959c568c93757a
POST_P=e085cf77b53eebb9ee94952342dbb929f78ada88382790bb3c60500ee6a1f30a
PRE_L=fdb051cdf1a379f94bd8ebd71594ddc619dc0a4ce8f364bc16e6f7fe2df82f06   # codex-local.sb pin from launch.sh
L_PRISTINE=32adc419ce5fe36e082df132b0dba97322d923c4b8ad2acb82d778615259cc36   # launch.sh pre-diff
L_TOKEN=422ea9b69bcaecd0c51948fc0e03974566e26b7940e83a95b01feeffdb5d75ab     # launch.sh after patch(1), token unresolved

want "$S/sb17-block.sb" 994cada9889adecc58064fa3118025c60cde3864b2bc82772cc4e0913b07d9f5
TODO=""
for spec in "agent $PRE_A $POST_A" "claude $PRE_A $POST_A" "codex-cmp $PRE_C $POST_C" "codex-personal $PRE_P $POST_P"; do
  set -- $spec
  [ -f "$B/$1.sb" ] || die "$B/$1.sb missing"
  [ ! -L "$B/$1.sb" ] || die "$B/$1.sb is a symlink"
  g=$(sha "$B/$1.sb")
  if [ "$g" = "$2" ]; then TODO="$TODO $1"
  elif [ "$g" != "$3" ]; then die "$B/$1.sb got=$g (neither pre nor post)"; fi
done
[ -f "$B/codex-local.sb" ] || die "codex-local.sb missing"
[ ! -L "$B/codex-local.sb" ] || die "codex-local.sb is a symlink"
g=$(sha "$B/codex-local.sb")
if [ "$g" = "$PRE_L" ]; then TODO="$TODO codex-local"
elif ! has_block "$B/codex-local.sb"; then die "codex-local.sb got=$g (neither pinned pre nor SB-17 state)"; fi
[ ! -L "$B/launch.sh" ] || die "launch.sh is a symlink"
# launch.sh state machine: exactly one pin line; its value must be the pre
# pin, the diff token, or the current codex-local sha (already repinned).
# Whole-file sha outside the two known states is reported (drift) but does not
# change what this one-line edit does.
L=$(sha "$B/launch.sh")
n=$(grep -c 'LSB=\$R/bin/codex-local\.sb; LSB_SHA=' "$B/launch.sh")
[ "$n" = 1 ] || die "launch.sh pin-line count $n != 1"
V=$(sed -n 's/.*LSB_SHA=\([0-9a-fA-Z_]*\).*/\1/p' "$B/launch.sh")
if [ "$V" = "$PRE_L" ]; then
  REPIN=old; [ "$L" = "$L_PRISTINE" ] || echo "NOTE launch.sh sha $L != known pristine $L_PRISTINE; pin line verified, proceeding"
elif [ "$V" = "SB17_POST_SHA_CODEX_LOCAL" ]; then
  REPIN=token; [ "$L" = "$L_TOKEN" ] || echo "NOTE launch.sh sha $L != known token state; pin line verified, proceeding"
elif [ "$V" = "$g" ] && [ "$g" != "$PRE_L" ]; then
  REPIN=done   # pin already equals sha of the (post-SB17) codex-local.sb
else
  die "launch.sh unrecognised pin value=$V sha=$L"
fi

# --- wait one dispatchd tick so no lane spawns mid-append ---
t0=$(python3 -c "import json;print(json.load(open('$R/queue/status.json'))['last_tick'])" 2>/dev/null) || t0=
if [ -n "$t0" ]; then
  t1=$t0
  for i in $(seq 1 45); do sleep 1; t1=$(python3 -c "import json;print(json.load(open('$R/queue/status.json'))['last_tick'])" 2>/dev/null); [ "$t1" != "$t0" ] && break; done
  [ "$t1" = "$t0" ] && { echo "NO TICK SEEN"; exit 8; }
  sleep 1
fi
echo "sb17 apply_epoch $E $(date)${TODO:+ append:$TODO}"

# --- append the deny block where needed (atomic mv, .bak-sb17 kept) ---
for f in $TODO; do
  cp -p "$B/$f.sb" "$B/$f.sb.bak-sb17-$E"
  m=$(stat -f %Lp "$B/$f.sb")
  cat "$B/$f.sb" "$S/sb17-block.sb" > "$B/.$f.sb.new" && chmod "$m" "$B/.$f.sb.new" && mv "$B/.$f.sb.new" "$B/$f.sb"
done

# --- verify post shas; codex-local post sha feeds the launch.sh pin ---
for spec in "agent $POST_A" "claude $POST_A" "codex-cmp $POST_C" "codex-personal $POST_P"; do
  set -- $spec; want "$B/$1.sb" "$2"
done
has_block "$B/codex-local.sb" || { echo "POST FAIL codex-local.sb lacks SB-17 block"; exit 10; }
P_LOCAL=$(sha "$B/codex-local.sb")

# --- repin launch.sh: LSB_SHA -> post sha of codex-local.sb ---
if [ "$REPIN" != done ]; then
  cp -p "$B/launch.sh" "$B/launch.sh.bak-sb17-$E"
  m=$(stat -f %Lp "$B/launch.sh")
  sed -e "s/LSB_SHA=$PRE_L/LSB_SHA=$P_LOCAL/" \
      -e "s/LSB_SHA=SB17_POST_SHA_CODEX_LOCAL/LSB_SHA=$P_LOCAL/" \
      "$B/launch.sh" > "$B/.launch.sh.new" && chmod "$m" "$B/.launch.sh.new"
  n=$(grep -c "LSB_SHA=$P_LOCAL" "$B/.launch.sh.new")
  [ "$n" = 1 ] || { echo "POST FAIL launch.sh repin produced $n pin lines"; rm -f "$B/.launch.sh.new"; exit 10; }
  grep -Fq 'SB17_POST_SHA_CODEX_LOCAL' "$B/.launch.sh.new" && { echo "POST FAIL token left in launch.sh"; rm -f "$B/.launch.sh.new"; exit 10; }
  mv "$B/.launch.sh.new" "$B/launch.sh"
fi

# --- verify: SBPL parses, launch.sh syntax, print the pin table ---
for f in agent claude codex-cmp codex-personal codex-local; do
  sandbox-exec -f "$B/$f.sb" /usr/bin/true >/dev/null 2>&1 || { echo "SANDBOX PARSE FAIL $f.sb — restore $B/$f.sb.bak-sb17-$E"; exit 11; }
done
bash -n "$B/launch.sh" || { echo "launch.sh SYNTAX FAIL — restore $B/launch.sh.bak-sb17-$E"; exit 11; }
echo "POST-SB17 SHAS"
for f in agent claude codex-cmp codex-personal codex-local; do echo "$(sha "$B/$f.sb")  $f.sb"; done
echo "$(sha "$B/launch.sh")  launch.sh"
echo "SB17 APPLIED ok"
