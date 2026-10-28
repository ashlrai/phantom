#!/bin/bash
# publish.sh <job-id>; installed with sibling bridge.py. No repo-wide lock.
set -u
umask 077
set -o pipefail
unset NODE_OPTIONS NODE_PATH OPENSSL_CONF ELECTRON_RUN_AS_NODE
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT_PATH="$SCRIPT_DIR/publish.sh"
LOCKED=0
if [ "${1:-}" = --locked ]; then LOCKED=1; shift; fi
J=${1:-}
case "$J" in ''|*[!A-Za-z0-9_.-]*|.|..) echo 'RESULT ABORT invalid-job'; exit 2;; esac
R=${BRIDGE_RUNS_DIR:-$HOME/.ashlr-runs}
export BRIDGE_RUNS_DIR="$R"
START_MS=${BRIDGE_PUBLISH_START_MS:-$(python3 -c 'import time; print(int(time.time()*1000))')}
export BRIDGE_PUBLISH_START_MS="$START_MS"
mkdir -p "$R" || exit 1
if [ "$LOCKED" = 0 ]; then exec >"$R/$J.publish" 2>&1; fi
OUTCOME=aborted
TEMP_INDEX=
TH=
finish() {
  rc=$?
  [ -z "$TEMP_INDEX" ] || rm -f -- "$TEMP_INDEX" "$TEMP_INDEX.lock"
  [ -z "$TH" ] || rm -rf -- "$TH"
  if [ "$LOCKED" = 0 ]; then
    python3 "$SCRIPT_DIR/bridge.py" station "$J" publish "$START_MS" "$OUTCOME" || true
  fi
  trap - EXIT
  exit "$rc"
}
trap finish EXIT
abort() { echo "RESULT ABORT $1"; exit 1; }
BASE= BR= WT= POOL=
[ -f "$R/$J.base" ] || abort missing-base
read -r BASE BR WT POOL < "$R/$J.base" || abort invalid-base
[ -n "$BASE" ] && [ -n "$BR" ] && [ -n "$WT" ] && [ -n "$POOL" ] || abort empty-base
cd -- "$WT" || abort no-wt
if [ "$LOCKED" = 1 ]; then
  # The private entrypoint must inherit the exact kernel lock, not merely a
  # caller-supplied flag. Re-locking this shared descriptor preserves ownership.
  python3 - "$WT" "$R" <<'LOCKPY' || abort missing-worktree-lock
import fcntl, hashlib, os, pathlib, sys
try:
    fd = int(os.environ['BRIDGE_LOCK_FD'])
    key = str(pathlib.Path(sys.argv[1]).resolve())
    path = pathlib.Path(sys.argv[2]) / 'locks' / (hashlib.sha256(key.encode()).hexdigest() + '.lock')
    actual, expected = os.fstat(fd), os.stat(path)
    if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
        raise ValueError('wrong lock')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except (KeyError, ValueError, OSError):
    sys.exit(1)
LOCKPY
fi
BASE=$(git rev-parse --verify "$BASE^{commit}" 2>/dev/null) || abort invalid-base
[ "$(git symbolic-ref -q --short HEAD)" = "$BR" ] || abort wrong-branch
# Agents intentionally leave edits uncommitted. "Empty" means no net content
# relative to BASE, including untracked files, excluding the handoff notes.
is_empty() {
  GIT_OPTIONAL_LOCKS=0 git diff --quiet "$BASE" -- . ':(exclude)BRIDGE_NOTES.md' || return 1
  local others
  others=$(git ls-files --others --exclude-standard -- . ':(exclude)BRIDGE_NOTES.md' ':(exclude)node_modules') || return 1
  [ -z "$others" ]
}
if is_empty; then OUTCOME=empty; echo 'RESULT EMPTY'; exit 0; fi
if [ "$LOCKED" = 0 ]; then
  python3 "$SCRIPT_DIR/bridge.py" lock "$WT" -- bash "$SCRIPT_PATH" --locked "$J"
  rc=$?
  case "$rc" in 0) OUTCOME=complete;; 3) OUTCOME=busy;; 4) OUTCOME=denied;; *) OUTCOME=aborted;; esac
  exit "$rc"
fi
# Revalidate after acquiring the worktree lock. The lock is also held by a live
# agent supervisor, so publishing never races its index or working directory.
if is_empty; then echo 'RESULT EMPTY'; exit 0; fi
REPO=$(git remote get-url origin | sed -E 's#.*[:/]([^/]+/[^/.]+)(\.git)?$#\1#') || abort origin
case "$REPO" in *[!A-Za-z0-9_./-]*|/*|*..*|*/*/*) abort invalid-origin;; esac
[[ "$REPO" = */* ]] || abort invalid-origin
NAME=${REPO#*/}
# Build the candidate in a private index. Refusals leave HEAD, the real index,
# working files and notes untouched, and retries retain their original base.
TEMP_INDEX=$(mktemp "$R/$J.index.XXXXXX") || abort temporary-index
rm -f -- "$TEMP_INDEX"
GIT_INDEX_FILE="$TEMP_INDEX" git read-tree "$BASE" || abort read-tree
GIT_INDEX_FILE="$TEMP_INDEX" git add -A -- . ':(exclude)BRIDGE_NOTES.md' ':(exclude)node_modules' || abort candidate
TREE=$(GIT_INDEX_FILE="$TEMP_INDEX" git write-tree) || abort candidate-tree
# Inspect NUL-delimited paths to handle whitespace/newlines without bypassing
# the protected-path or deletion gates. Unknown/binary deletions fail closed.
python3 - "$BASE" "$TREE" "$R/$J.job-line" "$R/$J.sensitive" "$NAME" <<'PY'
import fnmatch, os, re, subprocess, sys
base, tree, line_file, sensitive_file, name = sys.argv[1:]
def git(*args):
    return subprocess.check_output(['git', *args])
files = [os.fsdecode(p) for p in git('diff', '--no-renames', '--name-only', '-z', base, tree).split(b'\0') if p]
patterns = []
for path in ('.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'):
    proc = subprocess.run(['git', 'show', base + ':' + path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if proc.returncode == 0:
        patterns.extend(line.split()[0] for line in proc.stdout.decode('utf-8', 'replace').splitlines() if line.strip() and not line.lstrip().startswith('#'))
# A repository-wide default owner (`*`, `**`) names a reviewer, not a protected
# path; matching it would deny every job. Specific patterns stay protected.
patterns = [p for p in patterns if p.lstrip('/') not in ('*', '**', '**/*')]
def owned(path, pattern):
    pattern = pattern.lstrip('/')
    # CODEOWNERS **/ also matches zero directory levels, including in the
    # middle of a pattern. fnmatch alone requires a literal slash there.
    if '**/' in pattern:
        offset = pattern.index('**/')
        if owned(path, pattern[:offset] + pattern[offset + 3:]):
            return True
    if pattern.endswith('/'):
        pattern += '**'
    candidates = [path] + [path[:i] for i, char in enumerate(path) if char == '/']
    if '/' not in pattern:
        candidates += path.split('/')
    return any(fnmatch.fnmatchcase(candidate, pattern) for candidate in candidates)
denied = []
for path in files:
    protected = (path.split('/')[0] in ('.github', '.envrc', '.vscode', '.husky') or
                 re.search(r'CODEOWNERS|\.releaserc|(^|/)release[^/]*\.ya?ml$|(^|/)\.npmrc$', path))
    if protected or any(owned(path, pattern) for pattern in patterns):
        denied.append(path)
skips = sum(1 for entry in git('ls-files', '-v', '-z').split(b'\0') if entry[:1] in (b'S', b's'))
if denied or skips:
    # Counts avoid logging attacker-controlled filenames or terminal escapes.
    print('RESULT DENIED protected-paths=%d skip-worktree=%d' % (len(denied), skips))
    sys.exit(4)
try:
    with open(line_file, encoding='utf-8') as stream:
        job_line = stream.read()
except FileNotFoundError:
    job_line = ''
authorized = 'DELETIONS-OK' in job_line.split() and len(job_line.splitlines()) == 1
removed = 0
binary = False
for record in git('diff', '--no-renames', '--numstat', '-z', base, tree).split(b'\0'):
    if not record:
        continue
    _, deletions, path = record.split(b'\t', 2)
    if deletions == b'-':
        # A newly added binary has no deleted content; edits/removals of an
        # existing binary cannot be bounded by a line count.
        existed = subprocess.run(['git', 'cat-file', '-e', base + ':' + os.fsdecode(path)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        binary = binary or existed.returncode == 0
    else:
        removed += int(deletions)
if not authorized and (removed > 500 or binary):
    print('RESULT DENIED deletion-limit deleted-lines=%d binary=%s requires=DELETIONS-OK' % (removed, str(binary).lower()))
    sys.exit(4)
if name == 'ashlr-plugin':
    sensitive = r'^\.github/workflows/|^(server/|site/)?(package\.json|bun\.lockb?)$|^server/'
elif name == 'ashlr-stack':
    sensitive = r'^\.github/workflows/|^(package\.json|bun\.lockb?|packages/site/package\.json)$'
else:
    sensitive = r'^\.github/workflows/'
with open(sensitive_file, 'w', encoding='utf-8') as stream:
    stream.write('\n'.join(path for path in files if re.search(sensitive, path)))
PY
rc=$?
[ "$rc" = 0 ] || exit "$rc"
NOTES=
[ ! -f BRIDGE_NOTES.md ] || NOTES=$(cat BRIDGE_NOTES.md)
SENS=$(cat "$R/$J.sensitive")
TR='not run by publisher; agent touched tests and required CI gate merge'
if [ "${PUBLISH_FULL_TESTS:-0}" = 1 ]; then
  TH=$(mktemp -d) || abort test-home
  export RUSTUP_HOME=${RUSTUP_HOME:-$HOME/.rustup} CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}
  TC=()
  if [ -f Cargo.toml ]; then TC=(cargo test --quiet)
  elif [ -f package.json ] && grep -q '"test"' package.json; then TC=(npm test --silent); fi
  if [ "${#TC[@]}" -gt 0 ]; then
    # Install separately before publish; avoid implicit dependency/network
    # mutations and preserve the exact installation used by the agent.
    if [ -f package.json ] && [ ! -d node_modules ]; then abort missing-dependencies; fi
    HOME="$TH" PATH="$PWD/node_modules/.bin:$CARGO_HOME/bin:$PATH" perl -e 'alarm shift; exec @ARGV' 1500 "${TC[@]}" >"$R/$J.test.log" 2>&1
    rc=$?
    TR="full tests (temporary HOME) exit $rc; output retained locally"
    [ "$rc" = 0 ] || { echo "TEST $TR"; abort tests; }
  fi
fi
echo "TEST $TR"
TITLE=$(printf '%s\n' "$NOTES" | grep -m1 -v '^[[:space:]]*$' | sed 's/^#* *//' | cut -c1-60)
# A single-parent commit is built without reset --soft or rewriting the real
# index. Updating the branch is compare-and-swap against its observed head.
HEAD=$(git rev-parse HEAD) || abort head
if [ "$(git rev-parse "$HEAD^{tree}")" = "$TREE" ] &&
   [ "$(git rev-list --parents -n1 "$HEAD" | awk '{print NF-1, $2}')" = "1 $BASE" ] &&
   [[ "$(git log -1 --format=%s "$HEAD")" = "bridge($J): "* ]]; then
  SHA=$HEAD
else
  SHA=$(printf 'bridge(%s): %s\n' "$J" "${TITLE:-bridge work}" | git -c core.hooksPath=/dev/null commit-tree "$TREE" -p "$BASE") || abort commit
fi
[ "$(git rev-list --parents -n1 "$SHA" | awk '{print NF-1, $2}')" = "1 $BASE" ] || abort parent
git update-ref "refs/heads/$BR" "$SHA" "$HEAD" || abort head-changed
git reset --mixed --quiet "$SHA" || abort index
# Keep source notes for retry even after a push/PR failure.
[ ! -f BRIDGE_NOTES.md ] || cp BRIDGE_NOTES.md "$R/$J.notes.md"
gh repo view "masonwyatt23/$NAME" >/dev/null 2>&1 || gh repo fork "$REPO" --clone=false >/dev/null 2>&1 || abort fork
# Push to the exact configured fork URL; never trust a preexisting 'fork'
# remote that another worktree may have changed in shared repository config.
git -c core.hooksPath=/dev/null push -q --no-verify "https://github.com/masonwyatt23/$NAME.git" "$SHA:refs/heads/$BR" || abort push
DEF=$(gh repo view "$REPO" --json defaultBranchRef -q .defaultBranchRef.name) || abort default-branch
{
  printf 'Automated bridge job `%s` (pool: %s), single commit on base `%s`.\n\n' "$J" "$POOL" "${BASE:0:9}"
  printf '**Tests:** %s\n\n' "$TR"
  [ -z "$SENS" ] || printf '**Sensitive paths (needs Security OK):** %s\n\n' "$SENS"
  printf '<details><summary>Agent notes</summary>\n\n%s\n</details>\n' "$NOTES"
} >"$R/$J.body.md"
case "$J" in LAND*)
  SUP=$(grep -ohE "https://github.com/$REPO/pull/[0-9]+" "$R/$J.prompt" 2>/dev/null | head -1)
  [ -z "$SUP" ] || printf '\n\nSupersedes %s\n' "$SUP" >>"$R/$J.body.md"
;; esac
# Reuse an already-open PR when a previous attempt reached GitHub but the
# local process exited before recording its result.
URL=$(gh pr list --repo "$REPO" --head "masonwyatt23:$BR" --state open --json url --jq '.[0].url // empty') || abort pr-lookup
if [ -z "$URL" ]; then
  URL=$(gh pr create --repo "$REPO" --head "masonwyatt23:$BR" --base "$DEF" --title "bridge: $J" --body-file "$R/$J.body.md") || abort pr
fi
if [ -z "$SENS" ] && { gh pr merge "$URL" --repo "$REPO" --auto --squash >/dev/null 2>&1 || gh pr merge "$URL" --repo "$REPO" --auto >/dev/null 2>&1; }; then
  echo 'AUTO_MERGE on'
else
  echo 'NOTE AUTO_MERGE skipped-or-failed'
fi
echo "RESULT PR $URL"
