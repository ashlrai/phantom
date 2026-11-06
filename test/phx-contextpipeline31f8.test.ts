import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { runKnowledgeContextPack } from '../src/cli/knowledge-context-pack.js';

it('delivers a cited, byte-bounded snapshot to a worker through the file CLI', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-context-pipeline-')));
  const file = path.join(root, 'snapshot.json');
  const upstream = 'fake/upstream-雪-"quoted"-\\full-id';
  const current = 'fake/current-🌍-"full-id"';
  const related = 'fake/related-雪-\\full-id';
  const relatedPrefix = 'route 雪 "quoted"\\line\n';
  const expected = [
    { jobId: upstream, kind: 'output', text: 'Built 雪 "route"\\artifact\nready', truncated: false },
    { jobId: upstream, kind: 'task', text: 'Build the fake route 🌍', truncated: false },
    { jobId: current, kind: 'task', text: 'Review the fake route 雪', truncated: false },
    { jobId: related, kind: 'task', text: relatedPrefix, truncated: true },
  ];
  const expectedPack = expected.map(row => JSON.stringify(row) + '\n').join('');
  const byteBudget = Buffer.byteLength(expectedPack, 'utf8');
  const snapshot = {
    node: { jobId: current, upstreamJobIds: [upstream], query: 'route' },
    tasks: [
      { jobId: related, text: relatedPrefix + '🌍 remaining fake context' },
      { jobId: 'fake/unrelated', text: 'garden only' },
      { jobId: current, text: expected[2]!.text },
      { jobId: upstream, text: expected[1]!.text },
    ],
    outputs: [
      { jobId: current, text: 'route fake own output must never be retrieved' },
      { jobId: upstream, text: expected[0]!.text },
    ],
    byteBudget,
  };
  const original = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  fs.writeFileSync(file, original, { mode: 0o600 });
  let stdout = '';
  let stderr = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk); return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk); return true;
  });
  try {
    expect(await runKnowledgeContextPack(['--file', file])).toBe(0);
    const raw = stdout;
    expect(raw.endsWith('\n')).toBe(true);
    // Model the worker's JSONL consumer, parsing every emitted line independently.
    const rows: unknown[] = raw.slice(0, -1).split('\n').map(line => JSON.parse(line) as unknown);
    expect(rows).toEqual(expected);
    expect(Buffer.byteLength(raw, 'utf8')).toBe(byteBudget);
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(raw.length);
    expect(fs.readFileSync(file)).toEqual(original);

    stdout = '';
    expect(await runKnowledgeContextPack(['--file', file, '--json'])).toBe(0);
    const wrapper: unknown = JSON.parse(stdout);
    expect(wrapper).toEqual({ v: 1, jobId: current, pack: raw, bytes: byteBudget });
    const wrappedPack = (wrapper as { pack: string }).pack;
    expect(Buffer.from(wrappedPack, 'utf8')).toEqual(Buffer.from(raw, 'utf8'));
    expect(stderr).toBe('');
    expect(fs.readFileSync(file)).toEqual(original);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
