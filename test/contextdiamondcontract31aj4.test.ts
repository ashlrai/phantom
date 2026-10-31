/**
 * RQ-PHX-CONTEXTDIAMONDCONTRACT31AJ4 — day-one 3.30.0 contract: a diamond task
 * dependency (parallel predecessors `left` + `right` joining at `join`) must
 * deliver both predecessor outputs to the join node with their job citations
 * inside the declared UTF-8 byte budget. Drives the real pack builder,
 * citation reader, coverage summarizer and the `phm knowledge context-pack`
 * CLI against each other — nothing is reimplemented locally.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';
import { readNodeContextCitations } from '../src/core/fleet/node-context-citations.js';
import { summarizeNodeContextCoverage } from '../src/core/fleet/node-context-coverage.js';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import { cmdKnowledge } from '../src/cli/knowledge.js';

const LEFT = 'diamond/left';
const RIGHT = 'diamond/right';
const JOIN = 'diamond/join';
const GHOST = 'diamond/ghost';
const SIDE = 'unrelated/side';
const GARDEN = 'unrelated/garden';

type Row = { jobId: string; kind: 'task' | 'output'; text: string; truncated: boolean };

function rows(pack: string): Row[] {
  return pack.split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
}

/** Smallest possible cited output envelope for a job (one code point). */
function minOutputEnvelopeBytes(jobId: string, text: string): number {
  const first = Array.from(text)[0]!;
  return Buffer.byteLength(
    JSON.stringify({ jobId, kind: 'output', text: first, truncated: first !== text }) + '\n', 'utf8');
}

function diamond(): NodeContextPackInput {
  return {
    node: { jobId: JOIN, upstreamJobIds: [LEFT, RIGHT], query: 'route artifact' },
    outputs: [
      { jobId: LEFT, text: 'left branch built the route artifact 🌍\nwith "quoted" details' },
      { jobId: RIGHT, text: 'right branch verified the route artifact 雪\nintegrity report' },
      { jobId: JOIN, text: 'join already produced its own route artifact output' },
      { jobId: SIDE, text: 'unrelated output that mentions the route artifact' },
    ],
    tasks: [
      { jobId: LEFT, text: 'build the route artifact' },
      { jobId: RIGHT, text: 'verify the route artifact' },
      { jobId: JOIN, text: 'join both branch artifacts' },
      { jobId: SIDE, text: 'unrelated task about the route artifact' },
      { jobId: GARDEN, text: 'gardening chores with no overlap' },
    ],
    byteBudget: 8192,
  };
}

/** Diamond plus a third declared predecessor whose output was never recorded. */
function diamondWithGap(): NodeContextPackInput {
  const input = diamond();
  input.node.upstreamJobIds = [LEFT, RIGHT, GHOST];
  input.node.query = 'route artifact status';
  input.tasks = [
    { jobId: GHOST, text: 'route artifact ghost branch status report' },
    ...input.tasks,
  ];
  return input;
}

function sourceFor(input: NodeContextPackInput, jobId: string, kind: Row['kind']): string | undefined {
  return (kind === 'output' ? input.outputs : input.tasks)
    .find(record => record.jobId === jobId)?.text;
}

const ENV_KEYS = ['HOME', 'USERPROFILE', 'ASHLR_HOME'] as const;
let savedEnv: Array<readonly [string, string | undefined]>;
let root = '';
let home = '';
let work = '';

beforeEach(() => {
  savedEnv = ENV_KEYS.map(key => [key, process.env[key]] as const);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-diamond-')));
  home = path.join(root, 'home');
  work = path.join(root, 'work');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(work, { mode: 0o700 });
  process.env.HOME = home;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-31T00:33:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function cli(args: string[], stdinText = ''): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runKnowledgeContextPack(args, Readable.from([stdinText]), {
    stdout: text => { out += text; }, stderr: text => { err += text; },
  });
  return { code, out, err };
}

describe('diamond join node context contract', () => {
  it('ample budget delivers both predecessor outputs verbatim, cited and inside the UTF-8 budget', () => {
    const input = diamond();
    const pack = buildNodeContextPack(input);
    expect(pack.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(input.byteBudget);
    // Budget really is in UTF-8 bytes, not code units: the pack carries both.
    expect(Buffer.byteLength(pack, 'utf8')).toBeGreaterThan(pack.length);

    const emitted = rows(pack);
    // Both predecessor outputs arrive first and complete — the join sees them.
    expect(emitted[0]).toEqual({ jobId: LEFT, kind: 'output', text: input.outputs[0]!.text, truncated: false });
    expect(emitted[1]).toEqual({ jobId: RIGHT, kind: 'output', text: input.outputs[1]!.text, truncated: false });
    // Priority order is stable: upstream outputs, upstream tasks, own task, lexical matches.
    expect(emitted.map(row => [row.jobId, row.kind])).toEqual([
      [LEFT, 'output'], [RIGHT, 'output'], [LEFT, 'task'], [RIGHT, 'task'],
      [JOIN, 'task'], [SIDE, 'output'], [SIDE, 'task'],
    ]);
    // The join's own output is never prior context for itself; unrelated text
    // without query overlap never enters the pack at all.
    expect(emitted.some(row => row.jobId === JOIN && row.kind === 'output')).toBe(false);
    expect(emitted.some(row => row.jobId === GARDEN)).toBe(false);

    // Every emitted row traces to a real record of the same kind — task text
    // is never promoted into an output citation for a predecessor.
    for (const row of emitted) {
      const source = sourceFor(input, row.jobId, row.kind);
      expect(source).toBeDefined();
      expect(source!.startsWith(row.text)).toBe(true);
      expect(row.truncated).toBe(row.text !== source);
    }

    const citations = readNodeContextCitations(pack);
    expect(citations).toContainEqual({ jobId: LEFT, kind: 'output', truncated: false });
    expect(citations).toContainEqual({ jobId: RIGHT, kind: 'output', truncated: false });
    expect(citations.filter(c => c.kind === 'output').map(c => c.jobId)).toEqual([LEFT, RIGHT, SIDE]);

    const coverage = summarizeNodeContextCoverage(input, pack).upstream;
    expect(coverage).toEqual([
      { jobId: LEFT, state: 'included' },
      { jobId: RIGHT, state: 'included' },
    ]);
    // Coverage reports predecessor jobs only — unrelated citations stay out.
    expect(coverage.some(entry => entry.jobId === SIDE || entry.jobId === JOIN)).toBe(false);

    expect(buildNodeContextPack(input)).toBe(pack);
  });

  it('distinguishes missing, omitted and truncated under a deliberately small budget', () => {
    const input = diamondWithGap();
    const ample = buildNodeContextPack(input);
    const leftLine = ample.split('\n')[0]! + '\n';
    const rightOutput = input.outputs.find(o => o.jobId === RIGHT)!.text;
    // One byte short of RIGHT's smallest cited envelope: right cannot appear.
    const tight = Buffer.byteLength(leftLine, 'utf8') + minOutputEnvelopeBytes(RIGHT, rightOutput) - 1;

    const pack = buildNodeContextPack({ ...input, byteBudget: tight });
    expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(tight);

    const emitted = rows(pack);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toEqual({ jobId: LEFT, kind: 'output', text: input.outputs[0]!.text, truncated: false });
    const ghostTask = input.tasks.find(t => t.jobId === GHOST)!.text;
    expect(emitted[1]!.jobId).toBe(GHOST);
    expect(emitted[1]!.kind).toBe('task');
    expect(emitted[1]!.text.length).toBeGreaterThan(0);
    expect(ghostTask.startsWith(emitted[1]!.text)).toBe(true);
    expect(emitted[1]!.truncated).toBe(true);

    // Citations show what shipped: left output complete, a partial ghost task,
    // nothing at all for right. Citations alone cannot tell "no room" from
    // "no data" — that is what the coverage summarizer is for.
    expect(readNodeContextCitations(pack)).toEqual([
      { jobId: LEFT, kind: 'output', truncated: false },
      { jobId: GHOST, kind: 'task', truncated: true },
    ]);

    expect(summarizeNodeContextCoverage(input, pack).upstream).toEqual([
      { jobId: LEFT, state: 'included' },
      { jobId: RIGHT, state: 'omitted' },
      { jobId: GHOST, state: 'missing-output' },
    ]);
  });

  for (const fairUpstream of [false, true]) {
    it(`honours the byte budget at every boundary while truncation and citations stay consistent (fairUpstream=${fairUpstream})`, () => {
      const input = diamondWithGap();
      const full = Buffer.byteLength(buildNodeContextPack(input), 'utf8');
      const upstream = new Set(input.node.upstreamJobIds);
      const sources = new Map<string, string>();
      for (const record of input.outputs) sources.set(`${record.jobId}::output`, record.text);
      for (const record of input.tasks) sources.set(`${record.jobId}::task`, record.text);
      const priority = (row: Row): number =>
        upstream.has(row.jobId) ? (row.kind === 'output' ? 0 : 1) : row.jobId === JOIN ? 2 : 3;
      for (let byteBudget = 1; byteBudget <= full; byteBudget++) {
        const pack = buildNodeContextPack({ ...input, byteBudget, fairUpstream });
        expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(byteBudget);
        if (pack) expect(pack.endsWith('\n')).toBe(true);
        const emitted = rows(pack);
        const priorities = emitted.map(priority);
        expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
        const citations = readNodeContextCitations(pack);
        expect(citations).toHaveLength(emitted.length);
        emitted.forEach((row, index) => {
          const source = sources.get(`${row.jobId}::${row.kind}`);
          expect(source, `${row.jobId}/${row.kind} must come from a same-kind record`).toBeDefined();
          expect(source!.startsWith(row.text)).toBe(true);
          // untruncated rows always carry the complete text; the reverse
          // direction is the pinned defect in the dedicated test below.
          if (!row.truncated) expect(row.text).toBe(source);
          expect(row.text).not.toContain('\uFFFD');
          expect(citations[index]).toEqual({ jobId: row.jobId, kind: row.kind, truncated: row.truncated });
        });
      }
    });
  }

  it('flags an output truncated only when its delivered text is truly shortened', () => {
    const input = diamond();
    const leftText = input.outputs[0]!.text;
    const complete = buildNodeContextPack(input).split('\n')[0]! + '\n';
    // Exactly one byte below LEFT's complete line: the full text still fits,
    // but only under the truncated envelope, which serializes one byte smaller.
    const pack = buildNodeContextPack({ ...input, byteBudget: Buffer.byteLength(complete, 'utf8') - 1 });
    const row = rows(pack).find(r => r.jobId === LEFT && r.kind === 'output');
    expect(row).toBeDefined();
    // REGRESSION — fails today, see BRIDGE_NOTES.md: the row ships the complete
    // source text yet is flagged truncated:true, and coverage consequently
    // reports 'truncated' where every byte of the output was delivered.
    expect(row!.truncated).toBe(row!.text !== leftText);
  });

  it('fair-upstream retains both predecessor citations at a budget where the default pack keeps only one', () => {
    const input = diamond();
    const ample = buildNodeContextPack(input);
    const leftLine = ample.split('\n')[0]! + '\n';
    const rightOutput = input.outputs.find(o => o.jobId === RIGHT)!.text;
    // Enough for LEFT complete plus nearly RIGHT's minimum envelope.
    const budget = Buffer.byteLength(leftLine, 'utf8') + minOutputEnvelopeBytes(RIGHT, rightOutput) - 8;

    const plain = buildNodeContextPack({ ...input, byteBudget: budget });
    const fair = buildNodeContextPack({ ...input, byteBudget: budget, fairUpstream: true });
    expect(Buffer.byteLength(plain, 'utf8')).toBeLessThanOrEqual(budget);
    expect(Buffer.byteLength(fair, 'utf8')).toBeLessThanOrEqual(budget);

    expect(rows(plain)).toEqual([JSON.parse(leftLine)]);
    expect(readNodeContextCitations(plain)).toEqual([{ jobId: LEFT, kind: 'output', truncated: false }]);
    // Same input, same budget: fair sharing trades left completeness for a
    // cited slice of every predecessor — the join still sees both jobs.
    const fairCitations = readNodeContextCitations(fair);
    expect(fairCitations).toContainEqual({ jobId: LEFT, kind: 'output', truncated: true });
    expect(fairCitations).toContainEqual({ jobId: RIGHT, kind: 'output', truncated: true });

    expect(summarizeNodeContextCoverage(input, plain).upstream).toEqual([
      { jobId: LEFT, state: 'included' }, { jobId: RIGHT, state: 'omitted' }]);
    expect(summarizeNodeContextCoverage(input, fair).upstream).toEqual([
      { jobId: LEFT, state: 'truncated' }, { jobId: RIGHT, state: 'truncated' }]);
  });

  it('serves the join through the real CLI with exit 0 and leaves the snapshot and home untouched', async () => {
    const input = diamond();
    const file = path.join(work, 'snapshot.json');
    const content = JSON.stringify(input, null, 2) + '\n';
    fs.writeFileSync(file, content, { mode: 0o600 });

    const result = await cli(['--file', file, '--json', '--report', '--require-complete-upstream-outputs']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const body = JSON.parse(result.out);
    expect(body.v).toBe(1);
    expect(body.jobId).toBe(JOIN);
    // The CLI emits exactly what the real builder returns for the same input.
    expect(body.pack).toBe(buildNodeContextPack(input));
    expect(body.bytes).toBe(Buffer.byteLength(body.pack, 'utf8'));
    expect(body.bytes).toBeLessThanOrEqual(body.report.requestedByteBudget);
    expect(body.report.citedJobIds).toEqual(expect.arrayContaining([LEFT, RIGHT]));
    // The real citation reader and coverage summarizer agree on the CLI pack.
    const citations = readNodeContextCitations(body.pack);
    expect(citations).toContainEqual({ jobId: LEFT, kind: 'output', truncated: false });
    expect(citations).toContainEqual({ jobId: RIGHT, kind: 'output', truncated: false });
    expect(body.check.upstreamOutputCoverage).toEqual([
      { jobId: LEFT, state: 'included' }, { jobId: RIGHT, state: 'included' }]);
    expect(summarizeNodeContextCoverage(input, body.pack).upstream)
      .toEqual(body.check.upstreamOutputCoverage);

    // Read-only contract: the snapshot is byte-identical and nothing was
    // written beside it or into the isolated home.
    expect(fs.readFileSync(file).toString()).toBe(content);
    expect(fs.readdirSync(work)).toEqual(['snapshot.json']);
    expect(fs.readdirSync(home)).toEqual([]);

    // Non-JSON mode streams the identical pack; a bad budget override exits 2.
    expect(await cli(['--file', file])).toEqual({ code: 0, out: body.pack, err: '' });
    const bad = await cli(['--file', file, '--byte-budget', '0']);
    expect(bad.code).toBe(2);
    expect(bad.out).toBe('');
    expect(fs.readdirSync(work)).toEqual(['snapshot.json']);
  });

  it('returns exit 1 with a partial pack and per-state coverage when a small budget degrades the join', async () => {
    const input = diamondWithGap();
    const ample = buildNodeContextPack(input);
    const leftLine = ample.split('\n')[0]! + '\n';
    const rightOutput = input.outputs.find(o => o.jobId === RIGHT)!.text;
    const tight = Buffer.byteLength(leftLine, 'utf8') + minOutputEnvelopeBytes(RIGHT, rightOutput) - 1;

    const file = path.join(work, 'snapshot.json');
    const content = JSON.stringify(input) + '\n';
    fs.writeFileSync(file, content, { mode: 0o600 });
    // The snapshot requests ample room; the CLI override tightens it, the
    // same way an agent would probe a cheaper pack for the join.
    const result = await cli(['--file', file, '--json', '--byte-budget', String(tight),
      '--report', '--require-complete-upstream-outputs']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    const body = JSON.parse(result.out);
    expect(body.report.requestedByteBudget).toBe(tight);
    expect(body.bytes).toBeLessThanOrEqual(tight);
    expect(body.pack).toBe(buildNodeContextPack({ ...input, byteBudget: tight }));
    expect(body.check.upstreamOutputCoverage).toEqual([
      { jobId: LEFT, state: 'included' },
      { jobId: RIGHT, state: 'omitted' },
      { jobId: GHOST, state: 'missing-output' },
    ]);
    expect(summarizeNodeContextCoverage(input, body.pack).upstream)
      .toEqual(body.check.upstreamOutputCoverage);
    expect(fs.readFileSync(file).toString()).toBe(content);
  });

  it('keeps task citations from satisfying predecessor-output requirements end to end', async () => {
    // Diamond where RIGHT delivered its task but never produced an output.
    const input = diamond();
    input.outputs = input.outputs.filter(o => o.jobId !== RIGHT);
    const snapshot = JSON.stringify(input);

    const presence = await cli(['--stdin', '--json', '--require-upstream'], snapshot);
    expect(presence.code).toBe(0);
    expect(JSON.parse(presence.out).check.missingUpstreamJobIds).toEqual([]);

    const outputPresence = await cli(['--stdin', '--json', '--require-upstream-outputs'], snapshot);
    expect(outputPresence.code).toBe(1);
    expect(JSON.parse(outputPresence.out).check.missingUpstreamOutputJobIds).toEqual([RIGHT]);

    const complete = await cli(['--stdin', '--json', '--require-complete-upstream-outputs'], snapshot);
    expect(complete.code).toBe(1);
    expect(JSON.parse(complete.out).check.upstreamOutputCoverage).toEqual([
      { jobId: LEFT, state: 'included' }, { jobId: RIGHT, state: 'missing-output' }]);
  });

  it('runs the same diamond through the phm knowledge dispatcher with a failing exit line', async () => {
    const input = diamondWithGap();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from([JSON.stringify(input)]) as typeof process.stdin);
    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk); return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk); return true;
    });

    expect(await cmdKnowledge(['context-pack', '--stdin', '--json', '--report',
      '--require-complete-upstream-outputs'])).toBe(1);
    const lines = stdout.trimEnd().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    // Ample budget: both real predecessors land; the gap is surfaced distinctly.
    expect(lines[0].check.upstreamOutputCoverage).toEqual([
      { jobId: LEFT, state: 'included' },
      { jobId: RIGHT, state: 'included' },
      { jobId: GHOST, state: 'missing-output' },
    ]);
    expect(lines[0].report.citedJobIds).toEqual(expect.arrayContaining([LEFT, RIGHT]));
    expect(lines[1]).toEqual({ error: true, exitCode: 1 });
    expect(stderr).toBe('');
  });
});
