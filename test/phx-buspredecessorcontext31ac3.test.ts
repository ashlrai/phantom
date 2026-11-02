import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { summarizeNodeContextCoverage } from '../src/core/fleet/node-context-coverage.js';
import { buildNodeContextPack, type NodeContextPackInput } from '../src/core/fleet/node-context-pack.js';
import { getFleetJobText } from '../src/core/fleet/runs-job-texts.js';

const predecessor = 'RQ-PHX-PREDECESSOR31AC3';
const current = 'RQ-PHX-REVIEW31AC3';
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'bus-predecessor-context-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function postAndRead(job: string, claimedOutput: string): string {
  const options = { root, now: () => 100 };
  const envelope = {
    id: 'fake-message-1', from: 'fake-worker', to: 'fake-reviewer', priority: 'P2', ttl: 1000,
    body: { job, claimedOutput },
  };
  expect(appendBusInbox(envelope, options)).toMatchObject({ status: 'posted', cursor: 1 });
  const page = listBusInboxAfter(0, 50, options);
  expect(page.status).toBe('ok');
  if (page.status !== 'ok') throw new Error('Could not read the bus inbox');
  expect(page.messages).toHaveLength(1);
  expect(page.messages[0]?.envelope.body).toEqual(envelope.body);
  const body = page.messages[0]?.envelope.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.job !== 'string') {
    throw new Error('Expected a job reference in the bus message');
  }
  return body.job;
}

describe('bus predecessor notes in node context', () => {
  it('carries a referenced predecessor artifact into a cited upstream output', async () => {
    const artifact = 'Shared result: the graph review can reuse this output.\nEvidence: 雪 🌍 "ready".\n';
    await writeFile(join(root, `${predecessor}.notes.md`), artifact);
    const job = postAndRead(predecessor, 'This bus claim is not the artifact.');
    const notes = await getFleetJobText(job, 'notes', { runsDir: root });
    expect(notes).toMatchObject({ job: predecessor, state: 'ok', text: artifact, truncated: false });
    expect(notes.bytes).toBe(Buffer.byteLength(artifact));

    const input: NodeContextPackInput = {
      node: { jobId: current, upstreamJobIds: [predecessor] },
      tasks: [{ jobId: current, text: 'Review the shared result.' }],
      outputs: [{ jobId: notes.job, text: notes.text }], byteBudget: 1024,
    };
    const pack = buildNodeContextPack(input);
    const rows = pack.trimEnd().split('\n').map(line => JSON.parse(line));
    expect(rows).toEqual([
      { jobId: predecessor, kind: 'output', text: artifact, truncated: false },
      { jobId: current, kind: 'task', text: 'Review the shared result.', truncated: false },
    ]);
    expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(input.byteBudget);
    expect(summarizeNodeContextCoverage(input, pack).upstream).toEqual([{ jobId: predecessor, state: 'included' }]);
  });

  it('reports absent notes and never turns the bus claim into output', async () => {
    const job = postAndRead(predecessor, 'Fabricated successful output');
    const notes = await getFleetJobText(job, 'notes', { runsDir: root });
    expect(notes).toMatchObject({ job: predecessor, state: 'missing', bytes: null, text: '' });
    const input: NodeContextPackInput = {
      node: { jobId: current, upstreamJobIds: [predecessor] }, tasks: [],
      outputs: [{ jobId: notes.job, text: notes.text }], byteBudget: 512,
    };
    const pack = buildNodeContextPack(input);
    expect(pack).toBe('');
    expect(summarizeNodeContextCoverage(input, pack).upstream).toEqual([{ jobId: predecessor, state: 'missing-output' }]);
  });

  it('keeps a complete citation within a tight byte budget and does not treat a label as a graph edge', async () => {
    const artifact = '雪🌍 "quoted" \\ path\n'.repeat(30);
    await writeFile(join(root, `${predecessor}.notes.md`), artifact);
    const job = postAndRead(predecessor, 'untrusted bus claim');
    const notes = await getFleetJobText(job, 'notes', { runsDir: root });
    expect(notes).toMatchObject({ state: 'ok', text: artifact });
    const input: NodeContextPackInput = {
      node: { jobId: current, upstreamJobIds: [predecessor] }, tasks: [],
      outputs: [{ jobId: notes.job, text: notes.text }], byteBudget: 130,
    };
    const pack = buildNodeContextPack(input);
    expect(Buffer.byteLength(pack, 'utf8')).toBeLessThanOrEqual(input.byteBudget);
    const row = JSON.parse(pack.trimEnd());
    expect(row).toMatchObject({ jobId: predecessor, kind: 'output', truncated: true });
    expect(row.text.length).toBeGreaterThan(0);
    expect(artifact.startsWith(row.text)).toBe(true);
    expect(row.text).not.toContain('\uFFFD');
    expect(summarizeNodeContextCoverage(input, pack).upstream).toEqual([{ jobId: predecessor, state: 'truncated' }]);

    // The graph is supplied independently: a bus label alone is not a dependency.
    const noEdge = { ...input, node: { jobId: current, upstreamJobIds: [] } };
    expect(buildNodeContextPack(noEdge)).toBe('');
  });
});
