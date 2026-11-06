import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const name = 'phantom_fleet_job_reassign';
const job = 'RQ-PHX-FAKEONE01';
let home: string;
let queue: string;
let original: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reassign-mcp-'));
  vi.stubEnv('HOME', home);
  queue = join(home, '.ashlr-runs', 'queue');
  mkdirSync(queue, { recursive: true });
  original = `${job}\tphantom\tcodex-personal\twork\t/fake/prompt.md\n`;
  writeFileSync(join(queue, 'ready.tsv'), original);
  writeFileSync(join(queue, 'slots.json'), JSON.stringify({ lanes: {
    devin: { target: 1, floor: 0, ceiling: 4, held: false },
    'held-lane': { target: 0, floor: 0, ceiling: 2, held: true },
  } }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const call = async (args: unknown) => {
  const result = await callNativeTool(name, args);
  return { result, text: result.content[0].text };
};
const ready = () => readFileSync(join(queue, 'ready.tsv'), 'utf8');

describe('native MCP fleet job reassignment', () => {
  it('advertises the write-gated tool with a closed schema', () => {
    expect(nativeToolSafety(name)).toBe('append');
    expect(listNativeTools().find(tool => tool.name === name)).toMatchObject({
      inputSchema: { type: 'object', required: ['lane'], additionalProperties: false },
    });
  });

  it('plans a single job without changing the queue', async () => {
    const { result, text } = await call({ job, lane: 'devin', dryRun: true });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toMatchObject({ applied: false, lane: 'devin', verified: null, moved: [{ id: job }] });
    expect(ready()).toBe(original);
  });

  it('moves the job and records the MCP actor', async () => {
    const { result, text } = await call({ job, lane: 'devin', reason: 'recover lane' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toMatchObject({ applied: true, verified: true, moved: [{ id: job }] });
    expect(ready().split('\t')[2]).toBe('devin');
    const rows = readFileSync(join(queue, 'reassign.log'), 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].split('\t').slice(1)).toEqual([job, 'codex-personal', 'devin', 'mcp', 'recover lane']);
  });

  it('refuses a held target lane', async () => {
    const { text } = await call({ job, lane: 'held-lane' });
    expect(JSON.parse(text)).toEqual({ moved: false, reason: 'lane-held' });
    expect(ready()).toBe(original);
  });

  it.each([
    { job, lane: 'devin', extra: 1 }, { job, fromLane: 'codex-personal', lane: 'devin' },
    { job, lane: 'devin', force: true }, { job, lane: 'BAD lane' }, { lane: 'devin' },
    { job: '..', lane: 'devin' }, { job, lane: 'devin', dryRun: 'yes' },
    { job, lane: 'devin', reason: 'bad\nreason' }, { job, lane: 'devin', reason: 'x'.repeat(201) },
    { job, lane: 'devin', tier: 'invalid' },
  ])('rejects invalid arguments %j without writing', async args => {
    const { result, text } = await call(args);
    expect(result.isError).toBe(true);
    expect(text).toContain('invalid reassign arguments');
    expect(ready()).toBe(original);
  });

  it('plans all Phantom jobs on a source lane', async () => {
    const { text } = await call({ fromLane: 'codex-personal', lane: 'devin', dryRun: true });
    expect(JSON.parse(text)).toMatchObject({ applied: false, moved: [{ id: job }] });
    expect(ready()).toBe(original);
  });
});
