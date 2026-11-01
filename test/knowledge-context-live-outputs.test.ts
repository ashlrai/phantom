import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdKnowledge } from '../src/cli/knowledge.js';
import * as texts from '../src/core/fleet/runs-job-texts.js';
import { buildNodeContextPack } from '../src/core/fleet/node-context-pack.js';

let home: string;
let runs: string;
let out: string;
let err: string;
const descriptor = () => ({
  node: { jobId: 'current', upstreamJobIds: ['job-two', 'job-one'] },
  tasks: [{ jobId: 'current', text: 'original task' }],
  outputs: [] as { jobId: string; text: string }[], byteBudget: 4096,
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'context-live-'));
  runs = path.join(home, '.ashlr-runs'); fs.mkdirSync(runs);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });
function artifact(id: string, kind: 'notes' | 'body' | 'prompt', text: string): void {
  fs.writeFileSync(path.join(runs, `${id}.${kind === 'prompt' ? kind : `${kind}.md`}`), text);
}
async function run(data = descriptor(), flags = ['--json'], live = true): Promise<number> {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([JSON.stringify(data)]) as typeof process.stdin);
  return cmdKnowledge(['context-pack', '--stdin', ...(live ? ['--live-upstream-outputs'] : []), ...flags]);
}
function result() { return JSON.parse(out.split('\n')[0]!); }
function records() { return result().pack.trim().split('\n').map((line: string) => JSON.parse(line)); }

describe('live upstream context through public CLI', () => {
  it('preserves upstream citations, tasks, body fallback and scrubbed notes', async () => {
    artifact('job-one', 'notes', 'one token=fixture-value');
    artifact('job-two', 'body', 'two 🌍');
    artifact('job-two', 'prompt', 'PROMPT MUST NEVER APPEAR');
    expect(await run(descriptor(), ['--json', '--citations', '--require-complete-upstream-outputs'])).toBe(0);
    expect(records()).toEqual([
      { jobId: 'job-two', kind: 'output', text: 'two 🌍', truncated: false },
      { jobId: 'job-one', kind: 'output', text: 'one token=…', truncated: false },
      { jobId: 'current', kind: 'task', text: 'original task', truncated: false },
    ]);
    expect(result().citations.records.map((row: { jobId: string }) => row.jobId)).toEqual(['job-two', 'job-one', 'current']);
    expect(result().liveOutputSources).toEqual([
      { jobId: 'job-two', state: 'ok', source: 'body', truncated: false, bytes: Buffer.byteLength('two 🌍') },
      { jobId: 'job-one', state: 'ok', source: 'notes', truncated: false, bytes: 23 },
    ]);
    expect(err).toBe('');
  });

  it('keeps UTF-8 selection and fair-share behavior within the original budget', async () => {
    const text = '😀"\\\n'.repeat(200);
    artifact('job-one', 'notes', text); artifact('job-two', 'notes', text);
    const data = descriptor(); data.byteBudget = 220;
    expect(await run(data, ['--json', '--fair-upstream', '--report'])).toBe(0);
    expect(result().pack).toBe(buildNodeContextPack({ ...data, fairUpstream: true,
      outputs: data.node.upstreamJobIds.map(jobId => ({ jobId, text })) }));
    expect(result().bytes).toBe(Buffer.byteLength(result().pack));
    expect(result().bytes).toBeLessThanOrEqual(220);
    expect(records().map((row: { jobId: string }) => row.jobId)).toEqual(data.node.upstreamJobIds);
    expect(result().pack).not.toContain('�');
  });

  it('keeps missing and blank notes missing, including strict presence checks', async () => {
    artifact('job-one', 'notes', '   '); artifact('job-one', 'body', 'not a fallback for blank notes');
    expect(await run(descriptor(), ['--json', '--require-upstream-outputs', '--require-complete-upstream-outputs'])).toBe(1);
    expect(result().check.missingUpstreamOutputJobIds).toEqual(['job-two', 'job-one']);
    expect(result().check.upstreamOutputCoverage).toEqual([
      { jobId: 'job-two', state: 'missing-output' }, { jobId: 'job-one', state: 'missing-output' },
    ]);
    expect(result().liveOutputSources[0].state).toBe('missing');
    expect(records()).toHaveLength(1);
  });

  it('refuses symlink notes without falling back to a body', async () => {
    artifact('job-one', 'body', 'must not substitute');
    const target = path.join(home, 'target'); fs.writeFileSync(target, 'must not follow');
    fs.symlinkSync(target, path.join(runs, 'job-one.notes.md'));
    expect(await run(descriptor(), ['--json', '--require-complete-upstream-outputs'])).toBe(1);
    expect(result().liveOutputSources[1]).toMatchObject({ state: 'unreadable', source: null });
    expect(result().pack).not.toMatch(/must not/);
  });

  it('marks pre-pack truncation partial even when scrubbing makes the prefix fit', async () => {
    artifact('job-two', 'notes', 'x'.repeat(65537)); artifact('job-one', 'notes', 'complete');
    expect(await run(descriptor(), ['--json', '--require-complete-upstream-outputs', '--citations'])).toBe(1);
    expect(result().liveOutputSources[0]).toMatchObject({ truncated: true, bytes: 65537 });
    expect(records()[0]).toMatchObject({ text: '…', truncated: true });
    expect(result().check.upstreamOutputCoverage[0]).toEqual({ jobId: 'job-two', state: 'partial' });
    expect(result().citations.truncatedCitationCount).toBe(1);
  });

  it.each(['mixed', 'duplicate', 'invalid', 'too-many'])('rejects %s before any retained read', async kind => {
    const data = descriptor();
    if (kind === 'mixed') data.outputs = [{ jobId: 'job-one', text: 'inline' }];
    if (kind === 'duplicate') data.node.upstreamJobIds = ['job-one', 'job-one'];
    if (kind === 'invalid') data.node.upstreamJobIds = ['job-one', '../bad'];
    if (kind === 'too-many') data.node.upstreamJobIds = Array.from({ length: 33 }, (_, i) => `job-${i}`);
    const read = vi.spyOn(texts, 'getFleetJobText');
    expect(await run(data)).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });

  it('limits concurrent reads to four and retains upstream order', async () => {
    const data = descriptor(); data.node.upstreamJobIds = Array.from({ length: 10 }, (_, i) => `job-${i}`);
    let active = 0; let peak = 0;
    const actual = texts.getFleetJobText;
    vi.spyOn(texts, 'getFleetJobText').mockImplementation(async (...args) => {
      active++; peak = Math.max(peak, active);
      expect(args[1]).toBe('notes'); expect(args[2]).toEqual({ maxBytes: 65536 });
      try { return await actual(...args); } finally { active--; }
    });
    expect(await run(data)).toBe(0);
    expect(peak).toBe(4);
    expect(result().liveOutputSources.map((row: { jobId: string }) => row.jobId)).toEqual(data.node.upstreamJobIds);
  });

  it.each([{ flags: [] }, { flags: ['--markdown'] }])('keeps source health on stderr for text flags %j', async ({ flags }) => {
    artifact('job-one', 'notes', 'usable');
    expect(await run(descriptor(), flags)).toBe(0);
    expect(err).toContain('live upstream job-two: missing');
    expect(err).toContain('live upstream job-one: ok, source=notes');
    expect(out).not.toContain('live upstream'); expect(out).toContain('usable');
  });

  it('leaves stdin-only behavior unchanged when the flag is absent', async () => {
    const data = descriptor(); data.outputs = [{ jobId: 'job-one', text: 'inline' }];
    const read = vi.spyOn(texts, 'getFleetJobText');
    expect(await run(data, [], false)).toBe(0);
    expect(out).toBe(buildNodeContextPack(data)); expect(err).toBe('');
    expect(read).not.toHaveBeenCalled();
  });
});
