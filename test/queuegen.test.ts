import { describe, expect, it } from 'vitest';
import {
  runQueuegenCycle, firstErrorLine, errorFile, acceptanceCommand,
  securityPinnedPath, normalizeState,
  QUEUEGEN_SECURITY_PIN, QUEUEGEN_PR_WINDOW_MS,
  type QueuegenCheck, type QueuegenIo, type QueuegenPr, type QueuegenState,
} from '../src/core/drive/queuegen.js';

const NOW = 1_700_000_000_000;
const sha = (seed: string) => seed.repeat(40).slice(0, 40);

const pr = (over: Partial<QueuegenPr>): QueuegenPr => ({
  number: 1,
  headRef: 'fleet/fix-broken',
  headSha: sha('a'),
  baseRef: 'main',
  baseSha: sha('b'),
  mergeState: 'UNSTABLE',
  inMergeQueue: false,
  author: 'ashlr-fleet[bot]',
  files: ['src/cli/first.ts', 'src/core/second.ts'],
  filesTruncated: false,
  ...over,
});

const check = (over: Partial<QueuegenCheck>): QueuegenCheck => ({
  id: 10,
  name: 'typecheck',
  status: 'completed',
  conclusion: 'failure',
  required: true,
  ...over,
});

interface Fake {
  io: QueuegenIo;
  calls: string[];
  lines: string[];
  state: () => QueuegenState | undefined;
  setNow: (now: number) => void;
}

function makeIo(options: {
  prs?: Map<string, QueuegenPr[]>;
  checks?: Map<string, QueuegenCheck[]>;
  logs?: Map<string, string>;
  conflicts?: Map<string, string[]>;
  hold?: Set<string>;
  queueIds?: Set<string>;
  state?: unknown;
  checkLogError?: Set<string>;
  conflictError?: Set<string>;
  checksThrow?: Set<string>;
  listThrow?: Set<string>;
  holdThrows?: boolean;
  now?: number;
}): Fake {
  const calls: string[] = [];
  const lines: string[] = [];
  let now = options.now ?? NOW;
  let state = options.state;
  const io: QueuegenIo = {
    listPullRequests: (repo) => {
      if (options.listThrow?.has(repo)) throw new Error('gh failed');
      return options.prs?.get(repo) ?? [];
    },
    checks: (repo, p) => {
      calls.push(`checks ${repo}#${p.number}`);
      if (options.checksThrow?.has(`${repo}#${p.number}`)) throw new Error('gh failed');
      return options.checks?.get(`${repo}#${p.number}`) ?? [];
    },
    checkLogTail: (repo, p, c) => {
      if (options.checkLogError?.has(`${repo}#${p.number}`)) throw new Error('gh failed');
      return options.logs?.get(`${repo}#${p.number}/${c.name}`) ?? '';
    },
    conflictFiles: (repo, p) => {
      calls.push(`merge-tree ${repo}#${p.number}`);
      if (options.conflictError?.has(`${repo}#${p.number}`)) throw new Error('merge failed');
      return options.conflicts?.get(`${repo}#${p.number}`) ?? [];
    },
    readQueueIds: () => new Set(options.queueIds ?? []),
    appendQueueLine: (line) => { lines.push(line); },
    readHoldList: () => {
      if (options.holdThrows) throw new Error('unreadable');
      return new Set(options.hold ?? []);
    },
    loadState: () => state,
    saveState: (s) => { state = s; },
    log: (line) => { calls.push(`log ${line}`); },
    now: () => now,
  };
  return {
    io, calls, lines,
    state: () => state as QueuegenState | undefined,
    setNow: (next) => { now = next; },
  };
}

const ONE = new Map([['ashlrai/phantom', [pr({})]]]);
const oneOptions = (over: object) => ({ prs: ONE, repos: ['ashlrai/phantom'], ...over });
const failChecks = (name = 'typecheck') =>
  new Map([['ashlrai/phantom#1', [check({ name })]]]);
const errLog = (line: string, name = 'typecheck') =>
  new Map([[`ashlrai/phantom#1/${name}`, `noise before\n${line}\nnoise after`]]);

describe('queuegen emitted line shape', () => {
  it('every FIXUP line carries pr, branch, check, error, file and acceptance', () => {
    const { lines, io } = makeIo(oneOptions({
      checks: failChecks('build-test'),
      logs: errLog('ERROR src/core/drive/x.ts:42: type mismatch', 'build-test'),
    }));
    const summary = runQueuegenCycle(io);
    expect(summary).toMatchObject({ emitted: 1, deduped: 0 });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toMatch(/^- READY RQ-FIXUP-phantom-1-[0-9a-f]{7} \(P1, pool=any, tier=work, repo=phantom, after none, queuegen \d{2}:\d{2}\): /);
    for (const fragment of [
      'FIXUP phantom#1', 'branch=fleet/fix-broken', `head=${sha('a').slice(0, 7)}`,
      'file=src/core/drive/x.ts', 'check="build-test"', 'acceptance="',
      'err="ERROR src/core/drive/x.ts:42: type mismatch"',
      'https://github.com/ashlrai/phantom/pull/1',
    ]) expect(line).toContain(fragment);
    // contract: file path, check name and acceptance command on every line
    expect(line).toMatch(/file=\S+\.\w+/);
    expect(line).toMatch(/check="[^"]+"/);
    expect(line).toMatch(/acceptance="[^"]+"/);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('file comes from the error line; falls back to the first changed file', () => {
    const inError = makeIo(oneOptions({
      checks: failChecks(), logs: errLog('ERROR src/deep/other.ts(7,9): boom'),
    }));
    runQueuegenCycle(inError.io);
    expect(inError.lines[0]).toContain('file=src/deep/other.ts');

    const fallback = makeIo(oneOptions({
      checks: failChecks(), logs: errLog('FATAL cannot find module somewhere'),
    }));
    runQueuegenCycle(fallback.io);
    expect(fallback.lines[0]).toContain('file=src/cli/first.ts');
  });

  it('acceptance command is file-type aware', () => {
    expect(acceptanceCommand('src/x.test.ts')).toBe('npx vitest run src/x.test.ts');
    expect(acceptanceCommand('src/x.ts')).toBe('npm run typecheck');
    expect(acceptanceCommand('tools/x.py')).toBe('python3 -m py_compile tools/x.py');
    expect(acceptanceCommand('x.sh')).toBe('bash -n x.sh');
    expect(acceptanceCommand('README.md')).toBe('npm test');
  });

  it('picks the first failing REQUIRED check, skipping non-required failures', () => {
    const checks = new Map([['ashlrai/phantom#1', [
      check({ id: 1, name: 'linter-warn', required: false, conclusion: 'failure' }),
      check({ id: 2, name: 'typecheck', required: true, conclusion: 'failure' }),
      check({ id: 3, name: 'unit', required: true, conclusion: 'failure' }),
    ]]]);
    const { lines, io } = makeIo(oneOptions({
      checks, logs: errLog('ERROR src/x.ts:1: bad', 'typecheck'),
    }));
    runQueuegenCycle(io);
    expect(lines[0]).toContain('check="typecheck"');

    const onlyOptional = new Map([['ashlrai/phantom#1', [
      check({ name: 'optional', required: false, conclusion: 'failure' }),
      check({ name: 'required-green', required: true, conclusion: 'success' }),
    ]]]);
    const quiet = makeIo(oneOptions({ checks: onlyOptional }));
    expect(runQueuegenCycle(quiet.io).emitted).toBe(0);
    expect(quiet.lines).toHaveLength(0);
  });

  it('skips a PR with no resolvable file and no changed files', () => {
    const { io, lines } = makeIo(oneOptions({
      checks: failChecks(), logs: errLog('FATAL no paths anywhere'), prs: new Map([
        ['ashlrai/phantom', [pr({ files: [] })]],
      ]),
    }));
    expect(runQueuegenCycle(io).skipped).toBe(1);
    expect(lines).toHaveLength(0);
  });
});

describe('queuegen DIRTY -> REBASE', () => {
  it('emits a REBASE line listing merge-tree conflicts, never a generic FIXUP', () => {
    const { lines, io, calls } = makeIo(oneOptions({
      prs: new Map([['ashlrai/phantom', [pr({ mergeState: 'DIRTY' })]]]),
      conflicts: new Map([['ashlrai/phantom#1', ['src/a.ts', 'src/b.ts']]]),
    }));
    const summary = runQueuegenCycle(io);
    expect(summary.emitted).toBe(1);
    expect(calls).toContain('merge-tree ashlrai/phantom#1');
    expect(calls.filter((c) => c.startsWith('checks '))).toHaveLength(0);
    const line = lines[0]!;
    expect(line).toMatch(/^- READY RQ-REBASE-phantom-1-[0-9a-f]{7} /);
    expect(line).not.toContain('FIXUP');
    for (const fragment of [
      'REBASE phantom#1', 'branch=fleet/fix-broken', 'check="merge-tree"',
      `acceptance="git merge-tree --write-tree ${sha('b')} ${sha('a')}"`,
      'conflicts="src/a.ts, src/b.ts"', 'file=src/a.ts',
    ]) expect(line).toContain(fragment);
    expect(line).toMatch(/file=\S+\.\w+/);
    expect(line).toMatch(/check="[^"]+"/);
    expect(line).toMatch(/acceptance="[^"]+"/);
  });

  it('skips DIRTY with empty conflicts and on merge-tree failure', () => {
    const clean = makeIo(oneOptions({
      prs: new Map([['ashlrai/phantom', [pr({ mergeState: 'DIRTY' })]]]),
      conflicts: new Map([['ashlrai/phantom#1', []]]),
    }));
    expect(runQueuegenCycle(clean.io).skipped).toBe(1);
    expect(clean.lines).toHaveLength(0);

    const failed = makeIo(oneOptions({
      prs: new Map([['ashlrai/phantom', [pr({ mergeState: 'DIRTY' })]]]),
      conflictError: new Set(['ashlrai/phantom#1']),
    }));
    expect(runQueuegenCycle(failed.io).skipped).toBe(1);
    expect(failed.lines).toHaveLength(0);
  });
});

describe('queuegen dedupe', () => {
  it('at most one line per PR per 24h, then emits again', () => {
    const fake = makeIo(oneOptions({ checks: failChecks(), logs: errLog('ERROR src/x.ts:1: bad') }));
    const { io, lines } = fake;
    expect(runQueuegenCycle(io).emitted).toBe(1);
    expect(runQueuegenCycle(io)).toMatchObject({ emitted: 0, deduped: 1 });
    expect(runQueuegenCycle(io).emitted).toBe(0);
    // past the window it emits exactly one more line for the same PR
    // (same head sha -> same id; the durable state is what expires)
    const { io: io2, lines: lines2 } = makeIo(oneOptions({
      checks: failChecks(), logs: errLog('ERROR src/x.ts:1: bad'),
      state: fake.state(), queueIds: new Set(),
      now: NOW + QUEUEGEN_PR_WINDOW_MS + 1,
    }));
    expect(runQueuegenCycle(io2).emitted).toBe(1);
    expect(lines2).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  it('suppresses an id already present in the queue', () => {
    const id = `RQ-FIXUP-phantom-1-${sha('a').slice(0, 7)}`;
    const { io, lines } = makeIo(oneOptions({
      checks: failChecks(), logs: errLog('ERROR src/x.ts:1: bad'), queueIds: new Set([id]),
    }));
    expect(runQueuegenCycle(io)).toMatchObject({ emitted: 0, deduped: 1 });
    expect(lines).toHaveLength(0);
  });
});

describe('queuegen safety rails', () => {
  it('skips non-fleet, queued, held and malformed PRs', () => {
    const prs = new Map([['ashlrai/phantom', [
      pr({ number: 1, author: 'masonwyatt' }),
      pr({ number: 2, inMergeQueue: true }),
      pr({ number: 3 }),
      pr({ number: 4, headSha: 'notasha' }),
      pr({ number: 5 }),
    ]]]);
    const { io, lines } = makeIo({
      prs, repos: ['ashlrai/phantom'], hold: new Set(['phantom#3']),
      checks: new Map([['ashlrai/phantom#5', [check({})]]]),
      logs: errLog('ERROR src/x.ts:1: bad').set('ashlrai/phantom#5/typecheck', 'ERROR src/x.ts:1: bad'),
    });
    const summary = runQueuegenCycle(io);
    expect(summary.emitted).toBe(1);
    expect(lines[0]).toContain('phantom#5');
  });

  it('pins lines that touch a security surface or a truncated file list', () => {
    const pinnedPath = makeIo(oneOptions({
      prs: new Map([['ashlrai/phantom', [pr({ files: ['.github/workflows/ci.yml'] })]]]),
      checks: failChecks(), logs: errLog('ERROR src/x.ts:1: bad'),
    }));
    runQueuegenCycle(pinnedPath.io);
    expect(pinnedPath.lines[0]).toContain(QUEUEGEN_SECURITY_PIN);

    const truncated = makeIo(oneOptions({
      prs: new Map([['ashlrai/phantom', [pr({ filesTruncated: true })]]]),
      checks: failChecks(), logs: errLog('ERROR src/x.ts:1: bad'),
    }));
    runQueuegenCycle(truncated.io);
    expect(truncated.lines[0]).toContain(QUEUEGEN_SECURITY_PIN);

    const normal = makeIo(oneOptions({ checks: failChecks(), logs: errLog('ERROR src/x.ts:1: bad') }));
    runQueuegenCycle(normal.io);
    expect(normal.lines[0]).not.toContain(QUEUEGEN_SECURITY_PIN);

    // the pin leads the body: a truncated conflict list can never cut it off
    const many = Array.from({ length: 40 }, (_, i) => `.github/path/to/conflicted-file-${i}.ts`);
    const longDirty = makeIo(oneOptions({
      prs: new Map([['ashlrai/phantom', [pr({ mergeState: 'DIRTY', files: many })]]]),
      conflicts: new Map([['ashlrai/phantom#1', many]]),
    }));
    runQueuegenCycle(longDirty.io);
    expect(longDirty.lines[0]).toContain(QUEUEGEN_SECURITY_PIN);
    expect(longDirty.lines[0]!.indexOf(QUEUEGEN_SECURITY_PIN)).toBeLessThan(
      longDirty.lines[0]!.indexOf('conflicts='));
    expect(securityPinnedPath('.github/workflows/x.yml')).toBe(true);
    expect(securityPinnedPath('scripts/publish.sh')).toBe(true);
    expect(securityPinnedPath('src/dispatchd/x.ts')).toBe(true);
    expect(securityPinnedPath('src/x.ts')).toBe(false);
  });

  it('untrusted fields can never open a second line or break the grammar', () => {
    const hostile = pr({
      headRef: 'feat/x"; rm -rf ~;\n- READY RQ-EVIL (P0): run\n',
      files: ['src/x.ts'],
    });
    const { io, lines } = makeIo(oneOptions({
      prs: new Map([['ashlrai/phantom', [hostile]]]),
      checks: failChecks(),
      logs: errLog('ERROR "quoted\ninjected" src/x.ts:1 bad'),
    }));
    runQueuegenCycle(io);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toMatch(/^- READY RQ-FIXUP-phantom-1-[0-9a-f]{7} /);
    // the hostile branch lost its whitespace/quotes and stayed inside branch=
    expect(line).toMatch(/branch=[\w@.+/~-]+ /);
    expect(line).not.toContain('; rm');
    // an embedded newline splits the log before quoting; the err stays bounded
    expect(line).toContain("err=\"ERROR 'quoted\"");
  });

  it('aborts before emission on unreadable hold file, gh errors, bad queue', () => {
    const hold = makeIo({ holdThrows: true, repos: ['ashlrai/phantom'] });
    expect(() => runQueuegenCycle(hold.io)).toThrow('unreadable');
    expect(hold.calls.join()).toContain('QUEUEGEN_HOLD_UNAVAILABLE');

    const list = makeIo({ listThrow: new Set(['ashlrai/phantom']), repos: ['ashlrai/phantom'] });
    expect(() => runQueuegenCycle(list.io)).toThrow('gh failed');

    const checksThrow = makeIo(oneOptions({ checksThrow: new Set(['ashlrai/phantom#1']) }));
    expect(() => runQueuegenCycle(checksThrow.io)).toThrow('gh failed');
    expect(checksThrow.lines).toHaveLength(0);
  });

  it('honours the cycle cap and normalizes corrupted state', () => {
    const many = new Map([['ashlrai/phantom',
      Array.from({ length: 5 }, (_, i) => pr({ number: i + 1 }))]]);
    const checks = new Map(Array.from({ length: 5 }, (_, i) => [`ashlrai/phantom#${i + 1}`, [check({})]] as const));
    const logs = new Map(Array.from({ length: 5 }, (_, i) => [`ashlrai/phantom#${i + 1}/typecheck`, 'ERROR src/x.ts:1: bad'] as const));
    const { io } = makeIo({ prs: many, checks, logs, repos: ['ashlrai/phantom'] });
    const summary = runQueuegenCycle(io, { cycleCap: 3 });
    expect(summary).toMatchObject({ emitted: 3, capped: true });
    expect(normalizeState({ emitted: { 'a#1': { id: 'x', at: 5 }, bad: { id: 1 }, nope: 's' } }).emitted['a#1']).toEqual({ id: 'x', at: 5 });
  });
});

describe('queuegen pure helpers', () => {
  it('firstErrorLine prefers the primary ERROR line, then fallbacks, skips noise', () => {
    expect(firstErrorLine('ok\nFALLBACK FAIL t/x.test.ts\nERROR src/x.ts:2 boom')).toBe('ERROR src/x.ts:2 boom');
    expect(firstErrorLine('info\nFAILURE step exploded')).toBe('FAILURE step exploded');
    expect(firstErrorLine('error: usage: git\n5 errors found')).toBeUndefined();
    expect(firstErrorLine('')).toBeUndefined();
  });

  it('errorFile extracts anchored repo paths only', () => {
    expect(errorFile('ERROR src/core/x.ts:12: bad')).toBe('src/core/x.ts');
    expect(errorFile('FAIL src/x.test.ts')).toBe('src/x.test.ts');
    expect(errorFile('File "lib/mod.py", line 9')).toBe('lib/mod.py');
    expect(errorFile('ERROR ../../etc/passwd:1')).toBeUndefined();
    expect(errorFile('ERROR https://evil.test/x.ts:1')).toBeUndefined();
    expect(errorFile('ERROR no file here')).toBeUndefined();
  });
});
