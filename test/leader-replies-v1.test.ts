import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEADER_REPLIES_TAIL_BYTES, LEADER_REPLY_MAX_CHARS, parseLeaderReplies, readLeaderReplies } from '../src/core/fleet/mason-outbox.js';

const MARK = '**Reply for Mason** (for OUTBOXFALLBACK to copy):';
const pass = (time: string, reply: string) => `## 2026-11-17 ~${time} ET (leader on fake-host)\n- checked the queue\n${MARK} ${reply}\n`;

describe('parseLeaderReplies', () => {
  it('returns two replies newest first with the heading time', () => {
    expect(parseLeaderReplies(pass('09:00', '"Queue is moving."') + pass('10:00', '"Main is green."'))).toEqual([
      { at: '2026-11-17 10:00', text: 'Main is green.', source: 'plan-log' },
      { at: '2026-11-17 09:00', text: 'Queue is moving.', source: 'plan-log' },
    ]);
  });

  it('shows identical text once, at its newest time, and honours the limit', () => {
    const log = pass('08:00', '"Same words."') + pass('09:00', '"Other words."') + pass('10:00', '"Same  words."');
    expect(parseLeaderReplies(log).map(reply => [reply.at, reply.text])).toEqual([['2026-11-17 10:00', 'Same  words.'], ['2026-11-17 09:00', 'Other words.']]);
    expect(parseLeaderReplies(log, 1).map(reply => reply.text)).toEqual(['Same  words.']);
    expect(parseLeaderReplies(log, 0)).toEqual([]);
  });

  it('keeps quotes inside a reply and drops only the outer pair', () => {
    expect(parseLeaderReplies(pass('09:00', '"Main is "green" on every repo."'))[0]!.text).toBe('Main is "green" on every repo.');
  });

  it('reads a quoted paragraph on the next lines and leaves the plan notes after it out', () => {
    const quoted = `## 2026-11-17 ~09:00 ET\n${MARK}\n"First line.\nSecond line."\n\nNext pass: private plan notes.\n`;
    const block = `## 2026-11-17 ~10:00 ET\n${MARK}\n> Quoted line one.\n> Quoted line two.\n\nPrivate plan notes.\n`;
    expect(parseLeaderReplies(quoted + block).map(reply => reply.text)).toEqual(['Quoted line one.\nQuoted line two.', 'First line.\nSecond line.']);
  });

  it('gives at=unknown when no dated heading sits above the reply, and keeps file order', () => {
    const headless = `${MARK} "Cut off above."\n`;
    const undated = `## Late pass\n${MARK} "No clock here."\n`;
    expect(parseLeaderReplies(headless + pass('09:00', '"Dated."') + undated).map(reply => [reply.at, reply.text])).toEqual([
      ['unknown', 'No clock here.'], ['2026-11-17 09:00', 'Dated.'], ['unknown', 'Cut off above.'],
    ]);
  });

  it('returns nothing for an empty file or a log with no reply', () => {
    expect(parseLeaderReplies('')).toEqual([]);
    expect(parseLeaderReplies('# Plan log\n## 2026-11-17 ~09:00 ET\n- planning only\n')).toEqual([]);
  });

  it('caps each reply at 1,200 characters', () => {
    const [reply] = parseLeaderReplies(pass('09:00', `"${'word '.repeat(400)}"`));
    expect(reply!.text).toHaveLength(LEADER_REPLY_MAX_CHARS);
    expect(reply!.text.endsWith('…')).toBe(true);
  });

  it('reads the outbox shape as source outbox', () => {
    expect(parseLeaderReplies('## 2026-11-17T14:00:00Z\nShipped the card.\n', 5, 'outbox')).toEqual([{ at: '2026-11-17T14:00:00Z', text: 'Shipped the card.', source: 'outbox' }]);
  });
});

describe('readLeaderReplies', () => {
  let dir: string;
  let plan: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'leader-replies-v1-'));
    await mkdir(join(dir, 'leader'));
    plan = join(dir, 'leader', 'PLAN-LOG.md');
    vi.stubEnv('PHANTOM_PLAN_LOG', '');
    vi.stubEnv('ASHLR_RUNS_DIR', join(dir, 'unused'));
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  it('reads only the last 200 KB of a large plan log', async () => {
    const filler = `## 2026-11-16 ~08:00 ET\n${'- plan note\n'.repeat(Math.ceil(LEADER_REPLIES_TAIL_BYTES / 12) + 100)}`;
    await writeFile(plan, pass('07:00', '"Too old to read."') + filler + pass('10:00', '"Newest."'));
    const result = await readLeaderReplies({ planLog: plan });
    expect(result).toMatchObject({ schema: 'leader.replies.v1', version: 1, sourceState: 'healthy' });
    expect(result.replies).toEqual([{ at: '2026-11-17 10:00', text: 'Newest.', source: 'plan-log' }]);
  });

  it('merges the outbox beside the configured plan log, once per text, and skips it for one named file', async () => {
    await writeFile(plan, pass('09:00', '"Queue is moving."'));
    await writeFile(join(dir, 'leader', 'MASON-OUTBOX.md'), '## 2026-11-17T14:00:00Z\nQueue is moving.\n## 2026-11-17T16:00:00Z\nOutbox only.\n');
    expect((await readLeaderReplies({ planLog: plan })).replies).toEqual([
      { at: '2026-11-17T16:00:00Z', text: 'Outbox only.', source: 'outbox' },
      { at: '2026-11-17 09:00', text: 'Queue is moving.', source: 'plan-log' },
    ]);
    expect((await readLeaderReplies({ file: plan })).replies.map(reply => reply.source)).toEqual(['plan-log']);
  });

  it('says missing with a reason, and empty for an empty file', async () => {
    const missing = await readLeaderReplies({ planLog: plan });
    expect(missing).toMatchObject({ schema: 'leader.replies.v1', version: 1, sourceState: 'missing', replies: [], entries: [] });
    expect(missing.reason).toContain(`No PLAN-LOG file at ${plan}`);
    await writeFile(plan, '');
    expect(await readLeaderReplies({ planLog: plan })).toEqual({ schema: 'leader.replies.v1', version: 1, sourceState: 'healthy', replies: [], entries: [] });
  });

  it('prints schema, version and replies from `phm leader replies --json`', async () => {
    await writeFile(plan, pass('09:00', '"Queue is moving."') + `## Late pass\n${MARK} "No clock here."\n`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { runLeaderCli } = await import('../src/cli/leader.js');
    expect(await runLeaderCli(['replies', '--json', '--limit', '5', '--file', plan])).toBe(0);
    const result = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(result).toMatchObject({ schema: 'leader.replies.v1', version: 1, sourceState: 'healthy' });
    expect(result.replies).toEqual([{ at: 'unknown', text: 'No clock here.', source: 'plan-log' }, { at: '2026-11-17 09:00', text: 'Queue is moving.', source: 'plan-log' }]);
    expect(result.entries.map((entry: { at: string }) => entry.at)).toEqual(['2026-11-17 09:00']);
  }, 60_000);

  it('serves the same report to the Home cards, read only', async () => {
    await writeFile(plan, pass('09:00', '"Queue is moving."'));
    const { createFleetRunsApi } = await import('../src/core/verse/fleet-runs-api.js');
    const api = createFleetRunsApi({ runsDir: dir });
    const call = async (method: string, url: string) => {
      let status = 0; let body: unknown = null;
      const res = { headersSent: false, writeHead(code: number) { status = code; }, end(text: string) { body = JSON.parse(text); } };
      expect(await api({ cfg: {}, token: 'fake', allowDispatch: false } as never, { url, method, headers: {} } as never, res as never, url.split('?')[0]!, method)).toBe(true);
      return { status, body };
    };
    const ok = await call('GET', '/api/verse/fleet/runs/leader-replies?limit=1');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ schema: 'leader.replies.v1', version: 1, replies: [{ at: '2026-11-17 09:00', text: 'Queue is moving.', source: 'plan-log' }] });
    expect((await call('GET', '/api/verse/fleet/runs/leader-replies?limit=0')).status).toBe(400);
    expect((await call('POST', '/api/verse/fleet/runs/leader-replies')).status).toBe(405);
  }, 60_000);
});
