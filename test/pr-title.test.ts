import { describe, expect, it } from 'vitest';
import {
  buildDiffTitlePrompt,
  createLoopbackCompleter,
  inferType,
  normalizeTitle,
  PR_TITLE_MAX_CHARS,
  scopeFromDiff,
  titleFromDiff,
  titleFromModelAnswer,
  titleFromRouterLine,
  truncateTitle,
} from '../src/core/bridge/pr-title.js';

const QUEUE_DIFF = `diff --git a/src/core/queue/stats.ts b/src/core/queue/stats.ts
index 1111111..2222222 100644
--- a/src/core/queue/stats.ts
+++ b/src/core/queue/stats.ts
@@ -10,6 +10,12 @@ export function queueStats(rows) {
+export function evictionRate(rows) {
+  return rows.filter((row) => row.evicted).length / rows.length;
+}
 export function utilization(rows) {
diff --git a/test/queue-stats.test.ts b/test/queue-stats.test.ts
index 3333333..4444444 100644
--- a/test/queue-stats.test.ts
+++ b/test/queue-stats.test.ts
@@ -1,3 +1,8 @@
+it('reports the eviction rate', () => {
+  expect(evictionRate([{ evicted: true }])).toBe(1);
+});
`;

const DOCS_DIFF = `diff --git a/docs/DRIVE.md b/docs/DRIVE.md
index 1111111..2222222 100644
--- a/docs/DRIVE.md
+++ b/docs/DRIVE.md
@@ -40,3 +40,9 @@
+## Publication titles
+
+The publisher derives the PR title from the router line.
`;

const ROUTER_LINE = 'RQ-REAL-PR-TITLES-1-V2 (P0, pool=devin, tier=mid, repo=phantom, bet=bold, ' +
  'lead=Core, size<=250, family=REAL-PR-TITLES): VISION real-pr-titles. Bridge publish step ' +
  'titles PRs type(scope): summary from the diff via local model, RQ id moved to body. ' +
  'Acceptance: fixture-diff title tests, <=72 chars.';

describe('truncateTitle', () => {
  it('keeps short titles intact and caps at word boundary', () => {
    expect(truncateTitle('feat(core): add titles')).toBe('feat(core): add titles');
    const long = `feat: ${'word '.repeat(30)}end`;
    const out = truncateTitle(long);
    expect(out.length).toBeLessThanOrEqual(PR_TITLE_MAX_CHARS);
    expect(out).not.toMatch(/[ .,;:!?-]$/);
    expect(long.startsWith(out)).toBe(true);
  });
  it('hard-cuts a single overlong word', () => {
    const out = truncateTitle(`feat: ${'x'.repeat(100)}`);
    expect(out.length).toBeLessThanOrEqual(PR_TITLE_MAX_CHARS);
  });
});

describe('normalizeTitle', () => {
  it('collapses whitespace, strips quotes and falls back to the job id', () => {
    expect(normalizeTitle('  "feat: a  b\tc"  \nignored second line', 'RQ-1')).toBe('feat: a b c');
    expect(normalizeTitle('   \n  ', 'RQ-FALLBACK-42')).toBe('RQ-FALLBACK-42');
    expect(normalizeTitle('\u0000\u0007', 'RQ-CTRL')).toBe('RQ-CTRL');
  });
});

describe('titleFromDiff via the injected model (fixture diffs)', () => {
  it('keeps a conventional model answer verbatim', async () => {
    const result = await titleFromDiff(QUEUE_DIFF, 'RQ-QUEUE-1', async () => 'feat(queue): report eviction rate');
    expect(result).toEqual({ title: 'feat(queue): report eviction rate', source: 'model' });
  });
  it('wraps a bare summary with inferred type and diff-derived scope', async () => {
    const result = await titleFromDiff(QUEUE_DIFF, 'RQ-QUEUE-2', async () => 'Add eviction rate metric');
    expect(result.title).toBe('feat(queue): add eviction rate metric');
  });
  it('truncates a rambling model answer at 72 chars', async () => {
    const result = await titleFromDiff(DOCS_DIFF, 'RQ-DOCS-1',
      async () => `docs(docs): ${'update the publication guidance '.repeat(4)}`);
    expect(result.title.length).toBeLessThanOrEqual(PR_TITLE_MAX_CHARS);
    expect(result.title).toMatch(/^docs\(docs\): /);
  });
  it('falls back to the RQ id on model error', async () => {
    for (const complete of [
      async () => { throw new Error('server unreachable'); },
      async () => '',
      async () => '\n\n\n',
      async () => { throw new TypeError('abort'); },
    ]) {
      const result = await titleFromDiff(QUEUE_DIFF, 'RQ-ID-ON-ERROR', complete);
      expect(result).toEqual({ title: 'RQ-ID-ON-ERROR', source: 'fallback' });
    }
  });
  it('falls back to the RQ id when the answer echoes the id', async () => {
    const result = await titleFromDiff(QUEUE_DIFF, 'RQ-ECHO', async () => 'RQ-ECHO');
    expect(result.source).toBe('fallback');
  });
  it('sends the diff, not credentials, inside a bounded prompt', async () => {
    let seen = '';
    await titleFromDiff(QUEUE_DIFF, 'RQ-P', async (prompt) => { seen = prompt; return 'feat(queue): titles'; });
    expect(seen).toContain('evictionRate');
    expect(seen.length).toBeLessThan(20_000);
    expect(buildDiffTitlePrompt('x'.repeat(100_000)).length).toBeLessThan(20_000);
  });
});

describe('titleFromModelAnswer', () => {
  it('derives scope from the diff when wrapping a bare summary', () => {
    expect(scopeFromDiff(QUEUE_DIFF)).toBe('queue');
    expect(scopeFromDiff(DOCS_DIFF)).toBe('docs');
    expect(titleFromModelAnswer('Clarify publish titles', DOCS_DIFF, 'J')).toBe('docs(docs): clarify publish titles');
  });
  it('rejects empty or id-echo answers', () => {
    expect(titleFromModelAnswer('', QUEUE_DIFF, 'J-1')).toBeNull();
    expect(titleFromModelAnswer('J-1', QUEUE_DIFF, 'J-1')).toBeNull();
  });
});

describe('titleFromRouterLine', () => {
  it('strips the envelope and VISION marker, scopes from repo=', () => {
    const result = titleFromRouterLine(ROUTER_LINE, 'RQ-REAL-PR-TITLES-1-V2');
    expect(result.source).toBe('router-line');
    expect(result.title.length).toBeLessThanOrEqual(PR_TITLE_MAX_CHARS);
    expect(result.title).toMatch(/^[a-z]+\(phantom\): /);
    expect(result.title).not.toContain('RQ-REAL-PR-TITLES');
    expect(result.title).not.toContain('VISION');
    expect(result.title).not.toContain('Acceptance');
  });
  it('keeps the first task sentence only', () => {
    const result = titleFromRouterLine(
      'RQ-X (P1, pool=p, tier=t, repo=lexicon): Fix the recorder crash on empty input. Also update the docs.', 'RQ-X');
    expect(result.title).toBe('fix(lexicon): fix the recorder crash on empty input');
  });
  it('falls back to the job id for blank input', () => {
    expect(titleFromRouterLine('   ', 'RQ-BLANK').title).toBe('RQ-BLANK');
    expect(titleFromRouterLine('', 'RQ-BLANK').source).toBe('fallback');
  });
  it('titles lines without an envelope too', () => {
    const result = titleFromRouterLine('Update the steward docs for the disk policy.', 'RQ-D');
    expect(result.title).toBe('docs: update the steward docs for the disk policy');
  });
});

describe('inferType', () => {
  it.each([
    ['fix the crash in reap', 'fix'],
    ['add coverage for quarantine', 'test'],
    ['document the lease protocol', 'docs'],
    ['speed up target eviction', 'perf'],
    ['revert the bad merge', 'revert'],
    ['bump the lockfile version', 'build'],
    ['implement staged publication', 'feat'],
    ['polish the status page', 'chore'],
  ])('maps %s -> %s', (text, type) => {
    expect(inferType(text)).toBe(type);
  });
});

describe('createLoopbackCompleter', () => {
  it('refuses non-loopback and incomplete endpoints without network', async () => {
    const fetchImpl = async () => { throw new Error('must not be called'); };
    expect(createLoopbackCompleter({ baseUrl: 'https://example.invalid/v1', model: 'm', fetchImpl: fetchImpl as typeof fetch })).toBeNull();
    expect(createLoopbackCompleter({ baseUrl: 'http://192.168.1.5:11434/v1', model: 'm' })).toBeNull();
    expect(createLoopbackCompleter({ baseUrl: 'http://127.0.0.1:11434/v1' })).toBeNull();
  });
  it('posts a chat completion to the loopback endpoint', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'feat: ok' } }] }), { status: 200 });
    }) as typeof fetch;
    const complete = createLoopbackCompleter({ model: 'fixture-model', fetchImpl });
    expect(complete).not.toBeNull();
    expect(await complete!('prompt')).toBe('feat: ok');
    expect(bodies[0]).toMatchObject({ model: 'fixture-model', stream: false });
  });
});
