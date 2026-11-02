import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFleetContextSend } from '../scripts/fleet-context-send.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { MAX_BUS_ENVELOPE_BYTES, validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import * as texts from '../src/core/fleet/runs-job-texts.js';

let home: string;
let runs: string;
let file: string;
let root: string;
let output: string;
const input = () => ({ node: { jobId: 'job-current', upstreamJobIds: ['job-one', 'job-two', 'job-missing'] },
  tasks: [{ jobId: 'job-current', text: 'fake task' }], outputs: [] as { jobId: string; text: string }[], byteBudget: 65536 });
const args = () => ['--file', file, '--id', 'fake-message', '--from', 'fake-sender', '--to', 'fake-recipient', '--json'];
function artifact(job: string, kind: 'notes' | 'body' | 'prompt', text: string): void {
  writeFileSync(join(runs, `${job}.${kind === 'prompt' ? kind : `${kind}.md`}`), text);
}
function save(data: unknown): void { writeFileSync(file, JSON.stringify(data)); }
async function run(argv = args()): Promise<{ code: number; result: any }> {
  output = '';
  const code = await runFleetContextSend(argv, { inboxOptions: { root, now: () => 1000 }, write: text => { output += text; } });
  return { code, result: JSON.parse(output) };
}
function envelope() {
  const page = listBusInboxAfter(0, 50, { root, now: () => 1000 });
  if (page.status !== 'ok') throw new Error('inbox unavailable');
  expect(page.messages).toHaveLength(1);
  return page.messages[0]!.envelope;
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fleet-context-send-'));
  runs = join(home, '.ashlr-runs'); mkdirSync(runs);
  file = join(home, 'descriptor.json'); root = join(home, 'fleet');
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  save(input());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('fleet context bus handoff', () => {
  it('posts retained notes and body fallback with citations, source health and missing coverage', async () => {
    artifact('job-one', 'notes', 'fake note 🌍');
    artifact('job-two', 'body', 'fake body');
    artifact('job-two', 'prompt', 'fake prompt must stay private');
    const { code, result } = await run();
    expect(code).toBe(0);
    expect(result.receipt).toEqual({ status: 'posted', id: 'fake-message', cursor: 1 });
    expect(result.summary.upstream).toEqual([
      { jobId: 'job-one', state: 'included' }, { jobId: 'job-two', state: 'included' },
      { jobId: 'job-missing', state: 'missing-output' },
    ]);
    expect(result.summary.sources).toEqual([
      { jobId: 'job-one', state: 'ok', source: 'notes', truncated: false, bytes: Buffer.byteLength('fake note 🌍') },
      { jobId: 'job-two', state: 'ok', source: 'body', truncated: false, bytes: 9 },
      { jobId: 'job-missing', state: 'missing', source: null, truncated: false, bytes: null },
    ]);
    expect(output).not.toContain('fake note'); expect(output).not.toContain('fake prompt'); expect(output).not.toContain(home);
    const message = envelope();
    expect(message).toMatchObject({ id: 'fake-message', from: 'fake-sender', to: 'fake-recipient', priority: 'P2', ttl: 600000 });
    const body = message.body as { kind: string; jobId: string; pack: string; sources: unknown; upstream: unknown; trust: string };
    expect(body).toMatchObject({ kind: 'node-context-pack', jobId: 'job-current', trust: 'untrusted-context-data',
      sources: result.summary.sources, upstream: result.summary.upstream });
    expect(body.pack.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { jobId: 'job-one', kind: 'output', text: 'fake note 🌍', truncated: false },
      { jobId: 'job-two', kind: 'output', text: 'fake body', truncated: false },
      { jobId: 'job-current', kind: 'task', text: 'fake task', truncated: false },
    ]);
    expect(JSON.stringify(message)).not.toContain('fake prompt');
  });

  it('bounds Unicode and escaped JSON within the complete envelope and discloses both truncation stages', async () => {
    const data = input(); data.node.upstreamJobIds = ['job-one', 'job-two']; save(data);
    artifact('job-one', 'notes', 'x'.repeat(65537));
    artifact('job-two', 'notes', '😀"\\\n'.repeat(4000));
    const { code, result } = await run();
    expect(code).toBe(0);
    const message = envelope(); const checked = validateBusEnvelope(message);
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error('invalid envelope');
    expect(checked.byteLength).toBeLessThanOrEqual(MAX_BUS_ENVELOPE_BYTES);
    const body = message.body as { pack: string };
    expect(Buffer.byteLength(body.pack)).toBeLessThanOrEqual(8192);
    const rows = body.pack.trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0]).toMatchObject({ jobId: 'job-one', text: '…', truncated: true });
    expect(rows[1]).toMatchObject({ jobId: 'job-two', truncated: true });
    expect(rows[1].text).not.toContain('�');
    expect(result.summary.sources.map((row: { truncated: boolean }) => row.truncated)).toEqual([true, false]);
    expect(result.summary.upstream.map((row: { state: string }) => row.state)).toEqual(['truncated', 'truncated']);
  });

  it('uses deterministic IDs for duplicate and conflict and dry-run never writes', async () => {
    artifact('job-one', 'notes', 'fake original');
    expect((await run([...args(), '--dry-run'])).result.receipt.status).toBe('dry-run');
    expect(existsSync(root)).toBe(false);
    expect((await run()).result.receipt.status).toBe('posted');
    expect((await run()).result.receipt.status).toBe('duplicate');
    artifact('job-one', 'notes', 'fake changed');
    const conflict = await run();
    expect(conflict.code).toBe(5); expect(conflict.result.receipt.status).toBe('conflict');
    expect(JSON.stringify(envelope())).toContain('fake original');
  }, 30000);

  it('rejects bad descriptors and envelope headers before retained artifact reads', async () => {
    const spy = vi.spyOn(texts, 'getFleetJobText');
    for (const mutate of [
      (d: ReturnType<typeof input>) => { d.outputs = [{ jobId: 'job-one', text: 'fake' }]; },
      (d: ReturnType<typeof input>) => { d.node.upstreamJobIds = ['job-one', '../bad']; },
      (d: ReturnType<typeof input>) => { d.node.upstreamJobIds = ['job-one', 'job-one']; },
      (d: ReturnType<typeof input>) => { d.node.upstreamJobIds = Array.from({ length: 33 }, (_, i) => `job-${i}`); },
      (d: ReturnType<typeof input>) => { d.byteBudget = 0; },
    ]) {
      const data = input(); mutate(data); save(data);
      expect((await run()).result.error).toBe('invalid-descriptor');
    }
    save(input());
    expect((await run(args().map(v => v === 'fake-sender' ? 'bad sender' : v))).result.error).toBe('invalid-envelope');
    expect((await run(args().map(v => v === file ? 'relative.json' : v))).code).toBe(2);
    writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
    expect((await run()).result.error).toBe('descriptor-unavailable');
    rmSync(file); symlinkSync(join(home, 'missing'), file);
    expect((await run()).result.error).toBe('descriptor-unavailable');
    expect(spy).not.toHaveBeenCalled(); expect(existsSync(root)).toBe(false);
  });

  it('executes directly with an isolated home and documents invocation', () => {
    artifact('job-one', 'notes', 'fake CLI note');
    const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH };
    const script = resolve('scripts/fleet-context-send.ts');
    const help = spawnSync(process.execPath, ['--import', 'tsx', script, '--help'], { encoding: 'utf8', env });
    expect(help.status, help.stderr).toBe(0); expect(help.stdout).toContain('--dry-run');
    const child = spawnSync(process.execPath, ['--import', 'tsx', script, ...args()], { encoding: 'utf8', env });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout).receipt.status).toBe('posted');
    expect(child.stdout).not.toContain('fake CLI note'); expect(child.stdout).not.toContain(home);
    const page = listBusInboxAfter(0, 50, { root: join(home, '.ashlr', 'fleet') });
    expect(page.status).toBe('ok');
    if (page.status === 'ok') expect(JSON.stringify(page.messages[0]!.envelope.body)).toContain('fake CLI note');
  }, 30000);
});
