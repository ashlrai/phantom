/** RQ-LANECAPSN16LQ8: a lane that cannot do a job does not get it. All files are fakes under a temp dir. */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdQueue } from '../src/cli/queue.js';
import { cmdRoute } from '../src/cli/route.js';
import { GH_CONTEXT_PACK_FILE, GH_CONTEXT_PACK_MARKER, buildGhContextPack, ghContextPromptNote, writeGhContextPack } from '../src/core/fleet/gh-context-pack.js';
import { fitRoute, inferRequiredCapabilities, laneCanRun, laneCapabilities } from '../src/core/fleet/lane-capabilities.js';
import { routeToEligibleLane } from '../src/core/fleet/lane-route-eligibility.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';
import { formatQueueBatches, readQueueBatches } from '../src/core/queue/batches.js';

const prompts = JSON.parse(readFileSync(new URL('./fixtures/lane-capabilities/prompts.json', import.meta.url), 'utf8')) as
  { c499: Record<string, string>; pureCode: Record<string, string> };
const C499 = Object.entries(prompts.c499);
const NOW = new Date('2026-11-17T03:50:00.000Z');
const SKIP = 'route_skip: lane lacks gh';
const row = (lane: string, target: number): LaneTargetRow =>
  ({ lane, target, floor: 0, ceiling: 20, held: false, heldReason: null, heldUntil: null, pausedFrom: null, lastChange: null, changedBy: null });
// claude has the most room, so only the capability check can move a job off it.
const targets: LaneTargetsV1 = { v: 1, generatedAt: NOW.toISOString(), sourceState: 'healthy', lanes: [row('claude', 8), row('codex-personal', 4)] };
const context = { repo: 'phantom', prs: [{ number: 101, title: 'bridge: \u001b[31mRQ-EXAMPLE-ONE\u001b[0m', mergeable: 'CONFLICTING', author: 'dropped' }] };
const dirs: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'lane-caps-')); dirs.push(dir); return dir; };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('lane capabilities', () => {
  it('declares only what is proven: claude has no gh, three lanes have it, the rest is unknown', () => {
    expect(laneCapabilities('claude')).toEqual({ gh: false, network: null, browser: null, local_fs_outside_worktree: null });
    for (const lane of ['codex-personal', 'codex-cmp', 'devin']) expect(laneCapabilities(lane)).toEqual({ gh: true, network: null, browser: null, local_fs_outside_worktree: null });
    expect(laneCapabilities('gemini').gh).toBeNull();
    expect(laneCapabilities('claude', { claude: { gh: true } }).gh).toBe(true);
  });

  it.each(C499)('routes %s off claude with a typed reason', (job, prompt) => {
    const fit = fitRoute({ job, lane: 'claude', prompt, candidates: ['claude', 'codex-personal'] });
    expect(fit).toMatchObject({ schema: 'route.fit.v1', job, decision: 'route_skip', code: SKIP, next_lane: 'codex-personal', pack_would_fix: true });
    expect(fit.line).toBe('Lane claude cannot use gh, so this job goes to codex-personal. A gh context pack would let it stay.');
    const routed = routeToEligibleLane({ targets, needs: fit.needs, now: NOW });
    expect(routed.lane).toBe('codex-personal');
    expect(routed.skipped).toEqual([{ lane: 'claude', kind: 'lacks-capability', code: SKIP, reason: 'Lane cannot use gh.' }]);
  });

  it.each(C499)('keeps %s on claude once a gh context pack is attached', (job, prompt) => {
    const packed = `${prompt}\n\n${ghContextPromptNote(buildGhContextPack(job, context, NOW))}`;
    const fit = fitRoute({ job, lane: 'claude', prompt: packed, candidates: ['codex-personal'] });
    expect(fit).toMatchObject({ decision: 'route_with_pack', code: null, next_lane: null });
    expect(fit.line).toBe(`Lane claude cannot use gh, so the job reads ${GH_CONTEXT_PACK_FILE} instead.`);
    expect(routeToEligibleLane({ targets, needs: fit.needs, pack: true, now: NOW }).lane).toBe('claude');
  });

  it.each(Object.entries(prompts.pureCode))('still routes pure-code job %s to claude', (job, prompt) => {
    // The wrapper lists open PRs and forbids gh writes; neither is a need.
    expect(inferRequiredCapabilities(prompt).filter(need => need.capability === 'gh')).toEqual([]);
    expect(fitRoute({ job, lane: 'claude', prompt })).toMatchObject({ decision: 'route', code: null });
    expect(routeToEligibleLane({ targets, needs: inferRequiredCapabilities(prompt), now: NOW }).lane).toBe('claude');
  });

  it('does not let a pack cover a gh write, and waits when no lane was offered', () => {
    const fit = fitRoute({ lane: 'claude', prompt: 'Post the result with gh pr comment 12 --body done.', pack: true });
    expect(fit).toMatchObject({ decision: 'route_skip', code: SKIP, next_lane: null, pack_would_fix: false, needs: [{ capability: 'gh', access: 'write' }] });
    expect(fit.line).toBe('Lane claude cannot use gh, and no other lane was offered, so this job waits.');
  });

  it('shows an undeclared capability as unknown instead of refusing or approving it', () => {
    const fit = fitRoute({ lane: 'gemini', prompt: 'Run gh run view 7 --log-failed and take a screenshot of the page.' });
    expect(fit).toMatchObject({ decision: 'route', unknown: ['gh', 'browser'] });
    expect(fit.line).toBe('Lane gemini takes this job; whether it can use gh, browser is unknown.');
  });
});

describe('gh context pack', () => {
  it('keeps only bounded, cleaned read-only facts and marks what was not collected as unknown', () => {
    const pack = buildGhContextPack('RQ-A', { ...context, failed_run: { id: 7, log: `${'ok 1 - a passing test line\n'.repeat(4000)}END` } }, NOW);
    expect(pack.prs).toEqual([{ number: 101, title: 'bridge: RQ-EXAMPLE-ONE', mergeable: 'CONFLICTING' }]);
    expect(pack.failedRun?.log).toHaveLength(64 * 1024);
    expect(pack.failedRun?.log?.endsWith('END')).toBe(true);
    expect(buildGhContextPack('RQ-A', context, NOW)).toMatchObject({ readOnly: true, failedRun: null, generatedAt: NOW.toISOString() });
    expect(buildGhContextPack('RQ-A', { repo: 'phantom', failed_run: { id: 7 } }, NOW).prs).toBeNull();
    expect(() => buildGhContextPack('RQ-A', { repo: 'phantom' })).toThrow();
    expect(() => buildGhContextPack('../escape', context)).toThrow();
    expect(ghContextPromptNote(pack).split('\n')[0]).toBe(GH_CONTEXT_PACK_MARKER);
  });

  it('writes inside the worktree only', async () => {
    const worktree = await temp(), pack = buildGhContextPack('RQ-A', context, NOW);
    const path = await writeGhContextPack(worktree, pack);
    expect(path).toBe(join(worktree, GH_CONTEXT_PACK_FILE));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(pack);
    await expect(writeGhContextPack('relative', pack)).rejects.toThrow();
    const linked = await temp(), outside = await temp();
    await symlink(outside, join(linked, '.ashlr'));
    await expect(writeGhContextPack(linked, pack)).rejects.toThrow();
  });
});

describe('agent surfaces', () => {
  const [job, prompt] = C499[0]!;

  it('phm route fit attaches the pack for a job that needs it, and none for a job that does not', async () => {
    const dir = await temp(), input = join(dir, 'request.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await writeFile(input, JSON.stringify({ job, lane: 'claude', prompt, candidates: ['codex-personal'], gh_context: context }));
    expect(await cmdRoute(['fit', '--input', input, '--worktree', dir, '--json'])).toBe(0);
    const out = JSON.parse(String(log.mock.calls[0]![0]));
    expect(out).toMatchObject({ decision: 'route_with_pack', pack: { file: join(dir, GH_CONTEXT_PACK_FILE) } });
    expect(out.pack.prompt_note).toContain('instead of calling gh');
    expect(JSON.parse(await readFile(out.pack.file, 'utf8')).prs).toHaveLength(1);

    expect(await cmdRoute(['fit', '--input', input, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[1]![0]))).toMatchObject({ decision: 'route_skip', code: SKIP, next_lane: 'codex-personal', pack: null });

    const clean = await temp();
    await writeFile(input, JSON.stringify({ job: 'RQ-PURE', lane: 'claude', prompt: 'Rename one helper.', gh_context: context }));
    expect(await cmdRoute(['fit', '--input', input, '--worktree', clean, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[2]![0]))).toMatchObject({ decision: 'route', pack: null });
    await expect(readFile(join(clean, GH_CONTEXT_PACK_FILE))).rejects.toThrow();

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await writeFile(input, JSON.stringify({ job, lane: 'Not A Lane', prompt }));
    expect(await cmdRoute(['fit', '--input', input, '--json'])).toBe(2);
    expect(await cmdRoute(['fit', '--input', input])).toBe(2);
  });

  it('phm queue --json names ready jobs on a lane that cannot do them, with one plain line', async () => {
    const root = await temp();
    await mkdir(join(root, 'queue', 'prompts'), { recursive: true });
    const rows = [...C499.map(([id]) => [id, 'claude']), ['RQ-PACKED', 'claude'], ['RQ-PURE', 'claude'], ['RQ-ELSEWHERE', 'codex-personal'], ['RQ-NOPROMPT', 'claude']];
    const text: Record<string, string> = { ...prompts.c499, 'RQ-PACKED': `${prompt}\n${GH_CONTEXT_PACK_MARKER}`, 'RQ-PURE': 'Rename one helper.', 'RQ-ELSEWHERE': prompt };
    for (const [id, body] of Object.entries(text)) await writeFile(join(root, 'queue', 'prompts', `${id}.md`), body);
    await writeFile(join(root, 'queue', 'ready.tsv'), rows.map(([id, lane]) => `${id}\tphantom\t${lane}\tfrontier\t/elsewhere/queue/prompts/${id}.md\n`).join(''));
    const report = await readQueueBatches(root);
    // The unreadable prompt is not guessed at: evidence drops to partial and the row is not counted.
    expect(report.routeSkips).toMatchObject({ evidence: 'partial', checked: 7, packed: 1 });
    expect(report.routeSkips.skips.map(skip => skip.job)).toEqual(C499.map(([id]) => id));
    expect(report.routeSkips.skips[0]).toEqual({ job, lane: 'claude', code: SKIP, packWouldFix: true,
      line: `${job} is queued on claude, which cannot use gh. A gh context pack would let it stay.` });
    expect(formatQueueBatches(report).split('\n')[1]).toBe(
      `4 ready jobs sit on a lane that cannot do the work (${SKIP}): ${C499.map(([id]) => id).join(', ')}.`);

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv('HOME', await temp());
    expect(await cmdQueue(['--json'])).toBe(0);
    // No queue files: unknown stays unknown, never an empty "all clear".
    expect(JSON.parse(String(log.mock.calls[0]![0])).routeSkips).toEqual({ evidence: 'unknown', checked: null, packed: null, skips: [] });
    vi.unstubAllEnvs();
  });

  it('laneCanRun refuses claude for gh pr list, accepts codex-personal, ignores prose, and never guesses unknown', () => {
    const needs = inferRequiredCapabilities('Run `gh pr list` and report the open pull requests.');
    expect(needs.map(n => n.capability)).toEqual(['gh']);
    expect(laneCanRun('claude', needs)).toEqual({ ok: false, missing: ['gh'] });
    expect(laneCanRun('codex-personal', needs)).toEqual({ ok: true, missing: [] });
    expect(laneCanRun('gemini', needs)).toEqual({ ok: true, missing: [] });
    expect(inferRequiredCapabilities('The gh tool is mentioned in prose here, nothing is run.')).toEqual([]);
  });
});
