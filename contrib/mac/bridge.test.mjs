import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';

const helpers = resolve('contrib/mac');
const url = 'https://github.com/ashlrai/phantom/pull/42';
const head = 'fixture:codex-bridge/JOB';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  const env = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, LC_ALL: 'C', TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const run = (command, args, cwd = root) => spawnSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: 10_000,
  });
  const git = (...args) => {
    const result = run('/usr/bin/git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  return { root, bin, env, run, git };
}

function prFixture(t, steps) {
  const f = fixture(t);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  // Use shell builtins so retries exercise the helper, not repeated Node startup.
  // NUL-delimited argv capture preserves quotes, newlines and empty arguments.
  const script = `#!/bin/bash
root=${quote(f.root)}
read -r index < "$root/cursor"
printf '%s\\0' "$@" > "$root/call-$index"
printf '%s\\n' "$((index + 1))" > "$root/cursor"
kind=$2
if [[ $1 == api ]]; then
  while [[ $# -gt 0 && $1 != --method ]]; do shift; done
  kind=$2
fi
case $index in
${steps.map((step, index) => `${index})
  [[ $kind == ${quote(step.kind)} ]] || exit 99
  printf '%s' ${quote(step.out || '')}
  printf '%s' ${quote(step.err || '')} >&2
  exit ${step.code || 0} ;;`).join('\n')}
*) exit 99 ;;
esac
`;
  writeFileSync(join(f.bin, 'gh'), script, { mode: 0o700 });
  writeFileSync(join(f.bin, 'sleep'), '#!/bin/bash\nprintf "%s\\n" "$1" >> "$TMPDIR/sleeps"\n', { mode: 0o700 });
  writeFileSync(join(f.root, 'cursor'), '0\n');
  const body = join(f.root, 'body with spaces.md');
  writeFileSync(body, 'First line\n\n`literal` $(not-executed) "quote"\n');
  const args = ['phantom', head, 'main', 'Fix "retry" $(not-executed)', body];
  const run = (override = args) => f.run('/bin/bash', [join(helpers, 'pr-create.sh'), ...override]);
  const count = () => Number(readFileSync(join(f.root, 'cursor'), 'utf8'));
  const calls = () => Array.from({ length: count() }, (_, index) => {
    const args = readFileSync(join(f.root, `call-${index}`), 'utf8').split('\0').slice(0, -1);
    return { kind: args[0] === 'api' ? args[args.indexOf('--method') + 1] : args[1], args };
  });
  const done = () => assert.equal(count(), steps.length);
  return { ...f, run, args, body, calls, done };
}

const absent = () => [{ kind: 'list' }, { kind: 'GET' }];
const transient = (err = 'HTTP 502: Bad Gateway') => ({ kind: 'create', code: 1, err });

test('reuses a PR returned by the initial qualified-head list', (t) => {
  const f = prFixture(t, [{ kind: 'list', out: url }]);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${url}\n`);
  assert.deepEqual(f.calls()[0].args, ['pr', 'list', '--repo', 'github.com/ashlrai/phantom',
    '--head', head, '--base', 'main', '--state', 'open', '--json', 'url', '--jq', '.[].url']);
  f.done();
});

for (const code of [0, 1]) {
  test(`REST lookup recovers qualified-head list with exit ${code}`, (t) => {
    const f = prFixture(t, [{ kind: 'list', code }, { kind: 'GET', out: url }]);
    assert.equal(f.run().status, 0);
    assert.deepEqual(f.calls()[1].args, ['api', '--hostname', 'github.com', '--method', 'GET',
      'repos/ashlrai/phantom/pulls', '--raw-field', `head=${head}`, '--raw-field', 'base=main',
      '--raw-field', 'state=open', '--jq', '.[].html_url']);
    f.done();
  });
}

test('creates once with the exact title and body file', (t) => {
  const f = prFixture(t, [...absent(), { kind: 'create', out: url }]);
  assert.equal(f.run().status, 0);
  assert.deepEqual(f.calls()[2].args, ['pr', 'create', '--repo', 'github.com/ashlrai/phantom',
    '--head', head, '--base', 'main', '--title', f.args[3], '--body-file', f.body]);
  f.done();
});

for (const err of ['HTTP 500: server error', 'HTTP 503: unavailable', 'GraphQL: request timed out', 'GraphQL timeout']) {
  test(`retries transient failure: ${err}`, (t) => {
    const f = prFixture(t, [...absent(), transient(err), ...absent(), ...absent(), { kind: 'create', out: url }]);
    assert.equal(f.run().status, 0);
    assert.equal(readFileSync(join(f.root, 'sleeps'), 'utf8'), '2\n');
    f.done();
  });
}

function fallbackSteps() {
  return [
    ...absent(), transient(), ...absent(),
    ...absent(), transient(), ...absent(),
    ...absent(), transient(), ...absent(), ...absent(),
  ];
}

test('three transient failures back off twice then POST once with identical content', (t) => {
  const f = prFixture(t, [...fallbackSteps(), { kind: 'POST', out: url }]);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${url}\n`);
  assert.equal(readFileSync(join(f.root, 'sleeps'), 'utf8'), '2\n4\n');
  assert.equal(f.calls().filter(c => c.kind === 'create').length, 3);
  assert.deepEqual(f.calls().at(-1).args, ['api', '--hostname', 'github.com', '--method', 'POST',
    'repos/ashlrai/phantom/pulls', '--raw-field', `head=${head}`, '--raw-field', 'base=main',
    '--raw-field', `title=${f.args[3]}`, '--field', `body=@${f.body}`, '--jq', '.html_url']);
  f.done();
});

for (const err of ['HTTP 401: unauthorized', 'HTTP 403: forbidden', 'HTTP 422: validation failed', 'network timeout', 'HTTP 5000 invalid']) {
  test(`permanent or unrecognized error does not retry: ${err}`, (t) => {
    const f = prFixture(t, [...absent(), { kind: 'create', code: 1, err }, ...absent()]);
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /non-retryable/);
    assert.equal(result.stdout, '');
    f.done();
  });
}

test('ambiguous create success is reused without another mutation', (t) => {
  const f = prFixture(t, [...absent(), transient(), { kind: 'list', out: url }]);
  assert.equal(f.run().stdout, `${url}\n`);
  f.done();
});

test('duplicate rejection from another publisher is reconciled', (t) => {
  const f = prFixture(t, [...absent(), { kind: 'create', code: 1, err: 'already exists' },
    { kind: 'list' }, { kind: 'GET', out: url }]);
  assert.equal(f.run().status, 0);
  f.done();
});

test('PR appearing during backoff prevents the next create', (t) => {
  const f = prFixture(t, [...absent(), transient(), ...absent(), { kind: 'list', out: url }]);
  assert.equal(f.run().status, 0);
  f.done();
});

test('PR appearing just before REST fallback prevents POST', (t) => {
  const steps = fallbackSteps().slice(0, -2);
  const f = prFixture(t, [...steps, { kind: 'list', out: url }]);
  assert.equal(f.run().status, 0);
  f.done();
});

for (const existing of [true, false]) {
  test(`failed REST POST is reconciled, existing=${existing}`, (t) => {
    const f = prFixture(t, [...fallbackSteps(), { kind: 'POST', code: 1 },
      ...(existing ? [{ kind: 'list', out: url }] : absent())]);
    const result = f.run();
    assert.equal(result.status, existing ? 0 : 1);
    assert.equal(f.calls().filter(c => c.kind === 'POST').length, 1);
    f.done();
  });
}

test('unknown lookup state refuses creation and never prints raw CLI output', (t) => {
  const f = prFixture(t, [{ kind: 'list', code: 1, err: 'private diagnostic' },
    { kind: 'GET', code: 1, err: 'private diagnostic' }]);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot check existing PRs/);
  assert.doesNotMatch(result.stderr, /private diagnostic/);
  f.done();
});

for (const out of ['null', 'https://github.com/other/phantom/pull/42', `${url}\n${url}`]) {
  test(`invalid or ambiguous URL fails closed: ${JSON.stringify(out)}`, (t) => {
    const f = prFixture(t, [{ kind: 'list', out }]);
    assert.equal(f.run().status, 1);
    f.done();
  });
}

test('invalid arguments refuse before invoking gh', (t) => {
  const f = prFixture(t, []);
  for (const args of [[], ['../phantom', ...f.args.slice(1)],
    ['phantom', 'not-qualified', ...f.args.slice(2)],
    ['phantom', 'fixture:bad..branch', ...f.args.slice(2)],
    [...f.args.slice(0, 4), '/missing/body']]) {
    assert.equal(f.run(args).status, 1);
  }
  f.done();
});

function worktreeFixture(t) {
  const f = fixture(t);
  f.git('init', '--initial-branch=main');
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'fixture base');
  const base = f.git('rev-parse', 'HEAD');
  const destination = join(f.root, 'worktree with spaces\nand newline');
  const branch = 'codex-bridge/JOB';
  const run = (job = 'JOB', target = destination, start = 'main') =>
    f.run('/bin/bash', [join(helpers, 'worktree-add.sh'), f.root, job, target, start]);
  return { ...f, base, branch, destination, run };
}

test('launch creates a fresh branch and worktree with whitespace in the path', (t) => {
  const f = worktreeFixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git('-C', f.destination, 'branch', '--show-current'), f.branch);
  assert.equal(f.git('-C', f.destination, 'rev-parse', 'HEAD'), f.base);
});

test('launch resets only an unused stale branch to the explicit start ref', (t) => {
  const f = worktreeFixture(t);
  f.git('branch', f.branch);
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'new base');
  const current = f.git('rev-parse', 'main');
  assert.notEqual(current, f.base);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git('rev-parse', f.branch), current);
});

for (const state of ['live', 'locked', 'missing', 'main']) {
  test(`launch refuses a ${state} registered worktree without changing branch tip`, (t) => {
    const f = worktreeFixture(t);
    const live = join(f.root, 'existing');
    if (state === 'main') f.git('checkout', '-b', f.branch);
    else f.git('worktree', 'add', '-b', f.branch, live, 'main');
    if (state === 'locked') f.git('worktree', 'lock', live);
    if (state === 'missing') rmSync(live, { recursive: true });
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /attached to a registered worktree/);
    assert.equal(f.git('rev-parse', f.branch), f.base);
  });
}

test('similar branch names do not block safe reuse', (t) => {
  const f = worktreeFixture(t);
  f.git('branch', f.branch);
  f.git('worktree', 'add', '-b', `${f.branch}-OTHER`, join(f.root, 'other'), 'main');
  assert.equal(f.run().status, 0);
});

test('unrelated add failure does not reset an existing branch', (t) => {
  const f = worktreeFixture(t);
  f.git('branch', f.branch);
  f.git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'new base');
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, 'keep'), 'untouched');
  assert.equal(f.run().status, 1);
  assert.equal(f.git('rev-parse', f.branch), f.base);
  assert.equal(readFileSync(join(f.destination, 'keep'), 'utf8'), 'untouched');
});

test('worktree inventory failure refuses branch reset', (t) => {
  const f = worktreeFixture(t);
  f.git('branch', f.branch);
  writeFileSync(join(f.bin, 'git'), '#!/bin/bash\nif [[ "$*" == *"worktree list"* ]]; then exit 1; fi\nexec /usr/bin/git "$@"\n', { mode: 0o700 });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot inspect worktrees/);
  assert.equal(f.git('rev-parse', f.branch), f.base);
});

for (const kind of ['file-parent', 'missing-parent', 'dangling-symlink']) {
  test(`unusable destination preserves branch tip: ${kind}`, (t) => {
    const f = worktreeFixture(t);
    f.git('branch', f.branch);
    f.git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'new base');
    const blocked = join(f.root, 'blocked');
    if (kind === 'file-parent') writeFileSync(blocked, 'keep');
    if (kind === 'dangling-symlink') symlinkSync(join(f.root, 'missing'), blocked);
    const target = kind === 'dangling-symlink' ? `${blocked}/` : join(blocked, 'child');
    const result = f.run('JOB', target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /branch not reset/);
    assert.equal(f.git('rev-parse', f.branch), f.base);
  });
}

test('invalid launch inputs refuse without branch creation', (t) => {
  const f = worktreeFixture(t);
  for (const job of ['../bad', '-bad', 'bad..name', 'nested/job']) assert.equal(f.run(job).status, 1);
  assert.equal(f.run('JOB', f.destination, '--detach').status, 1);
  assert.equal(f.git('branch', '--list', 'codex-bridge/*'), '');
});
