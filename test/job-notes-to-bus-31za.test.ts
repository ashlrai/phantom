import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_NOTES_TTL_MS, runJobNotesToBus, type JobNotesToBusDependencies } from '../examples/agents/job-notes-to-bus.js';
import { MAX_BUS_ENVELOPE_BYTES, validateBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { getFleetJobText, type FleetJobTextV1 } from '../src/core/fleet/runs-job-texts.js';

const job = 'JOB-FAKE-NOTES-31ZA';
const ARGS = ['--job', job, '--from', 'fake-worker', '--to', 'fake-leader', '--id', 'fake-msg-1'];
const USAGE = 'usage: npx tsx examples/agents/job-notes-to-bus.ts --job ID --from ADDRESS --to ADDRESS --id MESSAGEID';

let home: string;
let runsDir: string;
let busRoot: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'job-notes-to-bus-'));
  runsDir = join(home, 'runs');
  busRoot = join(home, 'bus');
  await mkdir(runsDir);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function harness(overrides: JobNotesToBusDependencies = {}) {
  const output: string[] = [];
  const deps: JobNotesToBusDependencies = {
    readerOptions: { runsDir },
    inboxOptions: { root: busRoot, now: () => 100 },
    write: text => output.push(text),
    ...overrides,
  };
  return { output, deps, run: async (input: readonly string[] = ARGS) => {
    const code = await runJobNotesToBus(input, deps);
    return { code, result: JSON.parse(output.at(-1)!) as Record<string, unknown> };
  } };
}

function retained(now = 100) {
  const page = listBusInboxAfter(0, 50, { root: busRoot, now: () => now });
  if (page.status !== 'ok') throw new Error(`inbox not ok: ${page.status}`);
  return page.messages;
}

describe('job notes to bus', () => {
  it('posts the scrubbed notes artifact as one validated worker-notes envelope', async () => {
    await writeFile(join(runsDir, `${job}.notes.md`), 'Review complete.\nEvidence: fake-evidence-line\ntoken=fake-notes-credential\n');
    const h = harness();
    expect(await h.run()).toEqual({ code: 0, result: { status: 'posted', id: 'fake-msg-1', cursor: 1 } });
    const messages = retained();
    expect(messages).toHaveLength(1);
    const envelope = messages[0]!.envelope;
    expect(validateBusEnvelope(envelope).ok).toBe(true);
    expect(envelope).toMatchObject({ id: 'fake-msg-1', from: 'fake-worker', to: 'fake-leader', priority: 'P2', ttl: JOB_NOTES_TTL_MS });
    expect(JOB_NOTES_TTL_MS).toBe(600_000);
    const expected = await getFleetJobText(job, 'notes', { runsDir });
    expect(expected).toMatchObject({ state: 'ok', truncated: false });
    expect(expected.text).toContain('token=…');
    expect(expected.text).not.toContain('fake-notes-credential');
    expect(envelope.body).toEqual({ kind: 'worker-notes', jobId: job, text: expected.text, truncated: false });
    // The receipt carries no note text.
    expect(h.output[0]).not.toContain('fake-evidence-line');
    expect(h.output[0]).not.toContain('fake-notes-credential');
  });

  it('replays an identical post as duplicate and a changed body as conflict', async () => {
    await writeFile(join(runsDir, `${job}.notes.md`), 'fake notes v1\n');
    const h = harness();
    expect((await h.run()).result).toEqual({ status: 'posted', id: 'fake-msg-1', cursor: 1 });
    expect(await h.run()).toEqual({ code: 0, result: { status: 'duplicate', id: 'fake-msg-1', cursor: 1 } });
    expect(retained()).toHaveLength(1);
    await writeFile(join(runsDir, `${job}.notes.md`), 'fake notes v2\n');
    expect(await h.run()).toEqual({ code: 5, result: { status: 'conflict' } });
    expect(retained()).toHaveLength(1);
    expect(retained()[0]!.envelope.body).toMatchObject({ text: 'fake notes v1\n' });
  });

  it('does not post when notes are missing, unreadable, or the reader fails', async () => {
    const h = harness();
    expect(await h.run()).toEqual({ code: 1, result: { error: 'notes-missing' } });
    await mkdir(join(runsDir, `${job}.notes.md`));
    expect(await h.run()).toEqual({ code: 1, result: { error: 'notes-unreadable' } });

    const boom = harness({ read: async () => { throw new Error('fake-private-boom'); } });
    expect(await boom.run()).toEqual({ code: 1, result: { error: 'notes-unavailable' } });
    expect(boom.output[0]).not.toContain('fake-private-boom');

    const malformed = harness({
      read: (async () => ({ v: 1, job, kind: 'notes', state: 'ok', bytes: 1, truncated: 'yes', text: 42 })) as unknown as typeof getFleetJobText,
    });
    expect(await malformed.run()).toEqual({ code: 1, result: { error: 'notes-unavailable' } });
    const mismatch = harness({
      read: async () => ({ v: 1, job: 'JOB-OTHER', kind: 'notes', state: 'ok', bytes: 1, truncated: false, text: 'fake' }),
    });
    expect(await mismatch.run()).toEqual({ code: 1, result: { error: 'job-mismatch' } });
    expect(retained()).toHaveLength(0);
  });

  it('fails notes-too-large instead of silently truncating an oversized artifact', async () => {
    const append = vi.fn<typeof appendBusInbox>(() => ({ status: 'posted', id: 'fake-msg-1', cursor: 1 }));
    const big: FleetJobTextV1 = { v: 1, job, kind: 'notes', state: 'ok', bytes: 81_920, truncated: false, text: 'x '.repeat(40 * 1024) };
    const injected = harness({ read: async () => big, append });
    expect(await injected.run()).toEqual({ code: 6, result: { error: 'notes-too-large', limitBytes: MAX_BUS_ENVELOPE_BYTES } });
    expect(append).not.toHaveBeenCalled();

    // Same refusal through the real reader: a truncated 64 KiB artifact cannot fit the wire limit.
    await writeFile(join(runsDir, `${job}.notes.md`), 'x '.repeat(40 * 1024));
    const real = harness({ append });
    expect(await real.run()).toEqual({ code: 6, result: { error: 'notes-too-large', limitBytes: MAX_BUS_ENVELOPE_BYTES } });
    expect(append).not.toHaveBeenCalled();
    expect(retained()).toHaveLength(0);
  });

  it('forwards the reader truncated flag when the bounded text still fits', async () => {
    // A single oversized token is bounded by the reader and scrubbed to an ellipsis, so it posts.
    await writeFile(join(runsDir, `${job}.notes.md`), 'a'.repeat(100_000));
    const h = harness();
    expect(await h.run()).toEqual({ code: 0, result: { status: 'posted', id: 'fake-msg-1', cursor: 1 } });
    expect(retained()[0]!.envelope.body).toEqual({ kind: 'worker-notes', jobId: job, text: '…', truncated: true });
  });

  it('maps transport failures to stable receipts and exit codes', async () => {
    await writeFile(join(runsDir, `${job}.notes.md`), 'fake-private-note-text\n');
    for (const [status, code] of [['retryable', 3], ['full', 4], ['conflict', 5], ['unavailable', 1], ['invalid', 1]] as const) {
      const append = vi.fn<typeof appendBusInbox>(() => ({ status }));
      const h = harness({ append });
      expect(await h.run()).toEqual({ code, result: { status } });
      expect(append).toHaveBeenCalledOnce();
      const envelope = append.mock.calls[0]![0];
      expect(validateBusEnvelope(envelope).ok).toBe(true);
      expect(h.output[0]).not.toContain('fake-private-note-text');
    }
  });

  it('rejects malformed arguments and envelope fields before reading or posting', async () => {
    const read = vi.fn<typeof getFleetJobText>();
    const append = vi.fn<typeof appendBusInbox>();
    const h = harness({ read, append });
    const invalidArguments = [
      [], ARGS.slice(0, -2), [...ARGS, '--extra', 'x'], ARGS.slice(0, -1),
      ARGS.map(v => (v === job ? 'bad job' : v)),
      ARGS.map((v, i) => (i === 2 ? '--job' : v)),
      [...ARGS.slice(0, 6), '--id', '--from'],
    ];
    for (const input of invalidArguments) {
      expect(await h.run(input)).toEqual({ code: 2, result: { error: 'invalid-arguments', usage: USAGE } });
    }
    for (const input of [
      ARGS.map(v => (v === 'fake-worker' ? 'has space' : v)),
      ARGS.map(v => (v === 'fake-msg-1' ? 'bad id\n' : v)),
    ]) {
      const { code, result } = await h.run(input);
      expect(code).toBe(2);
      expect(result['error']).toBe('invalid-envelope');
    }
    expect(read).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('prints the documented invocation for --help without posting', async () => {
    const append = vi.fn<typeof appendBusInbox>();
    const h = harness({ append });
    expect(await h.run(['--help'])).toEqual({ code: 0, result: { usage: USAGE } });
    expect(append).not.toHaveBeenCalled();
  });

  it('runs as a script end to end against a scratch HOME', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'job-notes-cli-home-'));
    try {
      const scratchRuns = join(scratch, '.ashlr-runs');
      await mkdir(scratchRuns, { recursive: true });
      await writeFile(join(scratchRuns, `${job}.notes.md`), 'fake script notes body\n');
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', resolve('examples/agents/job-notes-to-bus.ts'), ...ARGS],
        { encoding: 'utf8', env: { HOME: scratch, PATH: process.env.PATH }, timeout: 30_000 },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ status: 'posted', id: 'fake-msg-1', cursor: 1 });
      expect(child.stdout).not.toContain('fake script notes body');
      const page = listBusInboxAfter(0, 50, { root: join(scratch, '.ashlr', 'fleet') });
      if (page.status !== 'ok') throw new Error(`inbox not ok: ${page.status}`);
      expect(page.messages).toHaveLength(1);
      const envelope = page.messages[0]!.envelope;
      expect(envelope).toMatchObject({ id: 'fake-msg-1', from: 'fake-worker', to: 'fake-leader', priority: 'P2' });
      expect(envelope.ttl).toBeGreaterThan(9 * 60 * 1000);
      expect(envelope.ttl).toBeLessThanOrEqual(JOB_NOTES_TTL_MS);
      expect(envelope.body).toEqual({ kind: 'worker-notes', jobId: job, text: 'fake script notes body\n', truncated: false });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
