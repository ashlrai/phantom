import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';
import type { NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';

const predecessor = 'RQ-PHX-PREDECESSOR31';
const missing = 'RQ-PHX-MISSING31';
const current = 'RQ-PHX-CURRENT31';
let runsDir: string;
let stdout: string;
let stderr: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'job-notes-context-'));
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(runsDir, { recursive: true, force: true });
});

async function readNotes(job: string, text?: string) {
  if (text !== undefined) await writeFile(join(runsDir, `${job}.notes.md`), text);
  return getFleetJobText(job, 'notes', { runsDir });
}

type PackRow = { jobId: string; kind: string; text: string; truncated: boolean };
type Envelope = {
  v: number;
  jobId: string;
  pack: string;
  bytes: number;
  check: { missingUpstreamJobIds: string[] };
  report: { emittedBytes: number; emittedRecordCount: number; citedJobIds: string[]; truncatedRecordCount: number };
};

async function pack(input: NodeContextPackInput) {
  const data = Buffer.from(JSON.stringify(input));
  const code = await runKnowledgeContextPack(
    ['--stdin', '--json', '--report', '--require-upstream'],
    Readable.from(Array.from(data, byte => Buffer.from([byte]))),
  );
  const envelope = JSON.parse(stdout) as Envelope;
  const rows = envelope.pack.split('\n').filter(Boolean).map(line => JSON.parse(line) as PackRow);
  expect(stderr).toBe('');
  expect(envelope.bytes).toBe(Buffer.byteLength(envelope.pack, 'utf8'));
  return { code, envelope, rows };
}

function snapshot(outputs: NodeContextPackInput['outputs'], upstreamJobIds = [predecessor], byteBudget = 4096): NodeContextPackInput {
  return { node: { jobId: current, upstreamJobIds }, tasks: [], outputs, byteBudget };
}

describe('fleet job notes to cited context', () => {
  it('carries a predecessor’s scrubbed takeaway from stored notes into JSONL', async () => {
    const notes = await readNotes(predecessor, 'Bridge takeaway: reuse the graph output.\ntoken=fake-secret-value\nBearer fake-bearer-value');
    expect(notes.state).toBe('ok');
    expect(notes.text).toBe('Bridge takeaway: reuse the graph output.\ntoken=…\nBearer …');
    const result = await pack(snapshot([{ jobId: notes.job, text: notes.text }]));

    expect(result.code).toBe(0);
    expect(result.envelope).toMatchObject({ v: 1, jobId: current, check: { missingUpstreamJobIds: [] },
      report: { emittedRecordCount: 1, citedJobIds: [predecessor], truncatedRecordCount: 0 } });
    expect(result.rows).toEqual([{ jobId: predecessor, kind: 'output', text: notes.text, truncated: false }]);
    expect(result.envelope.pack).not.toContain('fake-secret-value');
    expect(result.envelope.pack).not.toContain('fake-bearer-value');
  });

  it('reports a missing predecessor even when another predecessor is cited', async () => {
    const notes = await readNotes(predecessor, 'Reusable bridge takeaway.');
    const absent = await readNotes(missing);
    expect(absent).toMatchObject({ job: missing, state: 'missing', text: '' });
    const result = await pack(snapshot([
      { jobId: notes.job, text: notes.text }, { jobId: absent.job, text: absent.text },
    ], [predecessor, missing]));

    expect(result.code).toBe(1);
    expect(result.rows).toEqual([{ jobId: predecessor, kind: 'output', text: notes.text, truncated: false }]);
    expect(result.envelope.check.missingUpstreamJobIds).toEqual([missing]);
    expect(result.envelope.report.citedJobIds).toEqual([predecessor]);
  });

  it('reports an available predecessor as missing when the byte budget cannot emit a citation', async () => {
    const notes = await readNotes(predecessor, 'Available bridge takeaway.');
    expect(notes.state).toBe('ok');
    const result = await pack(snapshot([{ jobId: notes.job, text: notes.text }], [predecessor], 1));

    expect(result.code).toBe(1);
    expect(result.rows).toEqual([]);
    expect(result.envelope).toMatchObject({ pack: '', bytes: 0, check: { missingUpstreamJobIds: [predecessor] },
      report: { emittedBytes: 0, emittedRecordCount: 0, citedJobIds: [] } });
  });

  it('counts multibyte notes in bytes and checks coverage of the emitted records', async () => {
    const notes = await readNotes(predecessor, '雪🌍'.repeat(50));
    const other = await readNotes(missing, 'Second available takeaway.');
    expect(notes.state).toBe('ok');
    expect(other.state).toBe('ok');
    const firstLine = JSON.stringify({ jobId: predecessor, kind: 'output', text: '雪🌍', truncated: true }) + '\n';
    const byteBudget = Buffer.byteLength(firstLine, 'utf8');
    expect(byteBudget).toBeGreaterThan(firstLine.length);
    const result = await pack(snapshot([
      { jobId: notes.job, text: notes.text }, { jobId: other.job, text: other.text },
    ], [predecessor, missing], byteBudget));

    expect(result.code).toBe(1);
    expect(result.envelope.pack).toBe(firstLine);
    expect(result.envelope.bytes).toBe(byteBudget);
    expect(result.rows).toEqual([{ jobId: predecessor, kind: 'output', text: '雪🌍', truncated: true }]);
    expect(result.envelope.check.missingUpstreamJobIds).toEqual([missing]);
    expect(result.envelope.report).toMatchObject({ emittedBytes: byteBudget, emittedRecordCount: 1,
      citedJobIds: [predecessor], truncatedRecordCount: 1 });
  });
});
