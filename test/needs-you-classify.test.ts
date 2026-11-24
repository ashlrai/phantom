import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdNeedsYou } from '../src/cli/needs-you.js';
import type { WebServerHandle } from '../src/core/types.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';
import {
  AUTO_REASON, LIMIT_REASONS, NEEDS_YOU_AUDIT_FILE, classifyNeedsYou, listNeedsYou, readNeedsYouAudit,
  batchNeedsYou, resolveAutoNeedsYou, type NeedsYouOptions,
} from '../src/core/needs-you/index.js';

describe('classifyNeedsYou', () => {
  const hardLimit: Array<[string, string]> = [
    ['Rotate the deploy secret for the example app', 'secrets'],
    ['Approve the $40 plan upgrade for the example org', 'money'],
    ['Email the launch note to our customers', 'outside_send'],
    ['Delete the old example bucket and its files', 'destroy_data'],
    ['Type your password to unlock the example laptop', 'sign_in'],
    ['Enter the 2FA code for the example account', 'sign_in'],
    ['Approve the new device for the example login', 'sign_in'],
    ['ask:payment Top up the example pool (asked 2026-11-17T14:00:00.000Z)', 'money'],
    ['ask:outreach Say thanks to the example host (asked 2026-11-17T14:00:00.000Z)', 'outside_send'],
  ];
  it.each(hardLimit)('hard_limit: %s', (text, limit) => {
    const verdict = classifyNeedsYou({ text });
    expect(verdict).toEqual({ class: 'hard_limit', limit, reason: LIMIT_REASONS[limit as keyof typeof LIMIT_REASONS] });
  });

  const auto = [
    'Should the retry helper live in core or in cli?',
    'Pick between vitest workspaces and one config for the web suites',
    'Rebase PR #12 onto master and rerun the checks',
    'Which lane should take the flaky parser test?',
    'Rename fetchRows to readRows across the example module',
    'Bump the example lint rule from warn to error',
    'approval #3: Merge the refactor now? [merge it|wait] (asked 2026-11-17T14:00:00.000Z by claude)',
  ];
  it.each(auto)('auto: %s', (text) => {
    expect(classifyNeedsYou({ text })).toEqual({ class: 'auto', limit: null, reason: AUTO_REASON });
  });

  it.each([
    'Give the example bot access to the shared folder',
    'Send the summary over',
    'ok',
    '',
  ])('unclear stays with Mason: %j', (text) => {
    expect(classifyNeedsYou({ text }).class).toBe('hard_limit');
  });

  it('does not mistake engineering words for limits', () => {
    expect(classifyNeedsYou({ text: 'Cut token usage in the example tokenizer prompt' }).class).toBe('auto');
    expect(classifyNeedsYou({ text: 'Fix the keyboard focus order in the drawer' }).class).toBe('auto');
  });
});

describe('needs-you list and auto resolve', () => {
  const NOW = Date.parse('2026-11-18T12:00:00.000Z');
  let home = '';
  let opts: NeedsYouOptions & { runsDir: string };
  const ledger = () => join(opts.runsDir, 'NEEDS-MASON.md');
  const lines = [
    '# Needs Mason',
    '- [ ] Should the retry helper live in core or in cli?',
    '- [ ] approval #3: Merge the refactor now? [merge it|wait] (asked 2026-11-17T14:00:00.000Z by claude)',
    '- [ ] Email the launch note to our customers',
    '- [ ] ask:2fa Enter the code for the example account (asked 2026-11-17T14:00:00.000Z)',
    '',
  ].join('\n');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'example-needs-you-'));
    mkdirSync(join(home, 'runs'));
    opts = { runsDir: join(home, 'runs'), bus: { root: join(home, 'fleet'), now: () => NOW }, now: () => NOW };
    writeFileSync(ledger(), lines);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('batches hard limits into one short list with plain titles and one-word answers', () => {
    const list = listNeedsYou(opts);
    expect(list.counts).toEqual({ hardLimit: 2, auto: 2 });
    expect(list.hardLimit.map(i => [i.title, i.limit, i.answers])).toEqual([
      ['Email the launch note to our customers', 'outside_send', ['yes', 'no']],
      ['Enter the code for the example account', 'sign_in', ['yes', 'no']],
    ]);
    expect(list.auto.map(i => i.title)).toEqual(['Should the retry helper live in core or in cli?', 'Merge the refactor now?']);
    expect(list.hardLimit[1]!.answer).toMatch(/^phm asks answer [0-9a-f]{4,} yes\|no$/);
  });

  it('dry run reports the records and changes nothing', () => {
    const report = resolveAutoNeedsYou({ ...opts, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.resolved.map(r => r.action)).toEqual(['go ahead', 'merge it']);
    expect(readFileSync(ledger(), 'utf8')).toBe(lines);
    expect(existsSync(join(opts.runsDir, NEEDS_YOU_AUDIT_FILE))).toBe(false);
    expect(existsSync(join(home, 'fleet'))).toBe(false);
  });

  it('resolves only auto items and writes one audit record each', () => {
    const report = resolveAutoNeedsYou(opts);
    expect(report.failed).toEqual([]);
    expect(report.hardLimit).toBe(2);
    const audit = readNeedsYouAudit(opts);
    expect(audit).toHaveLength(2);
    for (const record of audit) {
      expect(Object.keys(record)).toEqual(['item', 'action', 'at', 'reason']);
      expect(Object.keys(record.item)).toEqual(['id', 'title']);
      expect(record.at).toBe('2026-11-18T12:00:00.000Z');
      expect(record.reason).toBe(AUTO_REASON);
    }
    const after = listNeedsYou(opts);
    expect(after.counts).toEqual({ hardLimit: 2, auto: 0 });
    // A second run has nothing left to do and writes nothing new.
    expect(resolveAutoNeedsYou(opts).resolved).toEqual([]);
    expect(readNeedsYouAudit(opts)).toHaveLength(2);
  });

  it('an unreadable ledger is unknown, not empty', () => {
    rmSync(ledger());
    mkdirSync(ledger());
    expect(listNeedsYou(opts).ledger).toBe('unavailable');
  });
});

describe('phm needs-you CLI', () => {
  let home = '';
  let out: string[] = [];
  const run = (args: string[]) => cmdNeedsYou([...args, '--runs-dir', join(home, 'runs')], {
    output: (t) => out.push(t), error: (t) => out.push(t), now: () => Date.parse('2026-11-18T12:00:00.000Z'),
    bus: { root: join(home, 'fleet') },
  });

  beforeEach(() => {
    out = [];
    home = mkdtempSync(join(tmpdir(), 'example-needs-you-cli-'));
    mkdirSync(join(home, 'runs'));
    writeFileSync(join(home, 'runs', 'NEEDS-MASON.md'), '- [ ] Pick the example test runner\n- [ ] Delete the example archive\n');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('--json lists items with class and reason', async () => {
    expect(await run(['--json'])).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(Object.keys(json)).toEqual(['schema', 'ledger', 'counts', 'hardLimit', 'auto']);
    expect(json.schema).toBe('phantom.needs-you.v1');
    expect(Object.keys(json.hardLimit[0])).toEqual(['id', 'ref', 'title', 'class', 'limit', 'reason', 'answers', 'forward', 'answer']);
    expect(json.hardLimit[0]).toMatchObject({ class: 'hard_limit', limit: 'destroy_data', reason: 'deletes or overwrites data' });
    expect(json.auto[0]).toMatchObject({ class: 'auto', limit: null, title: 'Pick the example test runner' });
  });

  it('resolve --auto --dry-run --json changes nothing', async () => {
    const before = readFileSync(join(home, 'runs', 'NEEDS-MASON.md'), 'utf8');
    expect(await run(['resolve', '--auto', '--dry-run', '--json'])).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(Object.keys(json)).toEqual(['schema', 'dryRun', 'ledger', 'resolved', 'failed', 'hardLimit']);
    expect(json).toMatchObject({ schema: 'phantom.needs-you.resolve.v1', dryRun: true, hardLimit: 1 });
    expect(json.resolved[0]).toEqual({
      item: { id: expect.stringMatching(/^nm-[0-9a-f]{12}$/), title: 'Pick the example test runner' },
      action: 'go ahead', at: '2026-11-18T12:00:00.000Z', reason: AUTO_REASON,
    });
    expect(readFileSync(join(home, 'runs', 'NEEDS-MASON.md'), 'utf8')).toBe(before);
  });

  it('plain text is one short list, and resolve needs --auto', async () => {
    expect(await run([])).toBe(0);
    const text = out[0]!.split('\n');
    expect(text).toHaveLength(3);
    expect(text[0]).toBe('1 need you:');
    expect(text[2]).toBe('1 the fleet can handle: phm needs-you resolve --auto');
    expect(text[1]).toMatch(/^ {2}1\. Delete the example archive \(deletes or overwrites data\) — yes \/ no: /);
    out = [];
    expect(await run(['resolve'])).toBe(2);
    expect(await run(['--bogus'])).toBe(2);
  });
});

describe('phm needs-you batch', () => {
  let home = '';
  let out: string[] = [];
  const run = (args: string[]) => cmdNeedsYou([...args, '--runs-dir', join(home, 'runs')], {
    output: (t) => out.push(t), error: (t) => out.push(t), now: () => 0, bus: { root: join(home, 'fleet') },
  });
  beforeEach(() => {
    out = [];
    home = mkdtempSync(join(tmpdir(), 'example-needs-you-batch-'));
    mkdirSync(join(home, 'runs'));
    writeFileSync(join(home, 'runs', 'NEEDS-MASON.md'),
      '- [ ] Pick the example test runner\n- [ ] Delete the example archive\n- [ ] Email the launch note to our customers\n');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('puts only hard limits in one message with a one-word reply each, and resolves nothing', async () => {
    expect(await run(['batch', '--json'])).toBe(0);
    const json = JSON.parse(out[0]!);
    expect(json).toMatchObject({ schema: 'phantom.needs-you.batch.v1', count: 2 });
    expect(json.message).toBe([
      '2 things need you:',
      '1. Delete the example archive (deletes or overwrites data) — yes or no',
      '2. Email the launch note to our customers (a message to someone outside the team) — yes or no',
      'Reply with one word each, like: 1 yes, 2 yes',
    ].join('\n'));
    expect(json.items.map((i: { title: string }) => i.title)).not.toContain('Pick the example test runner');
    expect(readFileSync(join(home, 'runs', 'NEEDS-MASON.md'), 'utf8')).not.toContain('[x]');
  });

  it('says so plainly when nothing needs Mason', async () => {
    writeFileSync(join(home, 'runs', 'NEEDS-MASON.md'), '- [ ] Pick the example test runner\n');
    expect(await run(['batch'])).toBe(0);
    expect(out).toEqual(['Nothing needs you.']);
    expect(batchNeedsYou({ runsDir: join(home, 'runs') }).message).toBe('');
  });
});

describe('/api/needs-you', () => {
  let home = '';
  let saved: string | undefined;
  const servers: WebServerHandle[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'example-needs-you-api-'));
    mkdirSync(join(home, 'runs'));
    writeFileSync(join(home, 'runs', 'NEEDS-MASON.md'), '- [ ] Pick the example test runner\n- [ ] Pay the example invoice\n');
    saved = process.env.ASHLR_RUNS_DIR;
    process.env.ASHLR_RUNS_DIR = join(home, 'runs');
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    if (saved === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = saved;
    rmSync(home, { recursive: true, force: true });
  });
  function call(h: WebServerHandle, method: string, path: string, body?: unknown) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: h.port, path, method, headers: {
        Host: `127.0.0.1:${h.port}`,
        ...(method === 'GET' ? readAuthHeaders(h.port) : { 'Content-Type': 'application/json', 'x-ashlr-token': h.token }),
      } }, (res) => {
        let out = ''; res.setEncoding('utf8');
        res.on('data', (c: string) => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  it('lists by class and resolves only auto items behind the mutation gate', async () => {
    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: true });
    servers.push(h);
    const got = JSON.parse((await call(h, 'GET', '/api/needs-you')).body);
    expect(got).toMatchObject({ schema: 'phantom.needs-you.v1', counts: { hardLimit: 1, auto: 1 }, audit: [] });
    expect(got.hardLimit[0]).toMatchObject({ limit: 'money', reason: 'money or billing' });
    expect((await call(h, 'POST', '/api/needs-you/resolve', { dryRun: 'yes' })).status).toBe(400);
    const done = await call(h, 'POST', '/api/needs-you/resolve', {});
    expect(JSON.parse(done.body)).toMatchObject({ dryRun: false, failed: [], hardLimit: 1 });
    const after = JSON.parse((await call(h, 'GET', '/api/needs-you')).body);
    expect(after.counts).toEqual({ hardLimit: 1, auto: 0 });
    expect(after.audit.map((r: { action: string }) => r.action)).toEqual(['go ahead']);
  });
});
