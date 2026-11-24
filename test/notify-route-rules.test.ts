/** `phm notify route <update.json>` and `phm notify rules`: fixtures per update type, rules file, team boundary, thread id. */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdNotify } from '../src/cli/notify.js';
import { OWNER_THREAD_ID } from '../src/core/comms/leader-mailbox.js';
import { classifyUpdate, readNotifyRules, setNotifyRule } from '../src/core/comms/notify-rules.js';
import { NOTIFY_STATUS_WORDS, type NotifyDeliveryPlan, type NotifyRulesView } from '../src/core/comms/notify-rules-schema.js';
import { fixedOwnerConfigDir } from '../src/core/comms/owner-channel.js';
import type { WebServerHandle } from '../src/core/types.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';
import { makeCfg } from './helpers/h1-fixture.js';

const fixture = (name: string) => resolve(process.cwd(), 'test/fixtures/notify-route', `${name}.json`);
const configDir = fixedOwnerConfigDir();
const rulesFile = join(configDir, 'comms', 'notify-rules.json');
let stdout = '';
let stderr = '';

async function run(...args: string[]): Promise<number> {
  stdout = ''; stderr = '';
  return cmdNotify(args);
}
async function plan(name: string, ...flags: string[]): Promise<NotifyDeliveryPlan> {
  expect(await run('route', fixture(name), '--json', ...flags)).toBe(0);
  return JSON.parse(stdout) as NotifyDeliveryPlan;
}
const steps = (p: NotifyDeliveryPlan) => p.deliveries.map(step => `${step.role}:${step.channel}:${step.action}:${step.delivery}`);

beforeEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'agent-network.toml'), [
    '[mason]', 'identities = [{ channel = "email", id = "mason@example.com" }]',
    '[team]', 'identities = [{ channel = "email", id = "evan@example.com" }]', '',
  ].join('\n'));
  vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { stdout += parts.join(' ') + '\n'; });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('notify route <update.json> with no rules file (defaults)', () => {
  it.each([
    ['decision', 'decision', 'decision', ['primary:imessage:send:now', 'mirror:desktop:send:now'], 'YES or NO', 'BLOCKED'],
    ['shipped', 'shipped', 'shipped', ['primary:email:send:next-digest', 'mirror:desktop:send:now'], null, 'VERIFIED'],
    ['incident', 'incident', 'incident', ['primary:imessage:send:now', 'mirror:desktop:send:now'], null, 'RUNNING'],
    ['digest', 'digest', 'digest', ['primary:email:send:now', 'mirror:desktop:send:now'], null, null],
    ['texts-digest', 'digest', 'texts-digest', ['primary:imessage:send:now', 'mirror:desktop:send:now'], null, null],
    ['fyi', 'fyi', 'fyi', ['primary:desktop:send:now'], null, 'ASSIGNED'],
  ] as const)('%s is a %s update', async (name, type, rule, expected, replyFormat, status) => {
    expect(existsSync(rulesFile)).toBe(false);
    const p = await plan(name);
    expect(p).toMatchObject({ schema: 'phantom.notify.plan.v1', version: 1, sent: false, type, rule, replyFormat, status,
      rulesSource: 'defaults', recipient: 'owner', insideTeam: true, draftOnly: false, threadId: OWNER_THREAD_ID });
    expect(steps(p)).toEqual(expected);
    expect(p.text).toBe(JSON.parse(readFileSync(fixture(name), 'utf8')).text);
  });

  it('an unknown type falls back to the app only, and an unknown status word stays unknown', async () => {
    const p = await plan('unknown');
    expect(p).toMatchObject({ type: 'unknown', rule: null, status: 'unknown', replyFormat: null });
    expect(steps(p)).toEqual(['primary:desktop:send:now']);
    expect(p.reason).toContain('desktop app only');
  });

  it('keeps the five status words exactly', () => {
    expect(NOTIFY_STATUS_WORDS).toEqual(['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED']);
    expect(classifyUpdate({ text: 'Approve the release?' }).type).toBe('decision');
    expect(classifyUpdate({ text: 'PR 12 merged.' }).type).toBe('shipped');
  });

  it('an outside-team recipient is a draft on every channel, never a send; a team member is a send', async () => {
    const outside = await plan('outside-team');
    expect(outside).toMatchObject({ insideTeam: false, draftOnly: true, sent: false, status: 'RECEIVED',
      recipient: { channel: 'email', id: 'stranger@example.com' } });
    expect(steps(outside)).toEqual(['primary:email:draft:next-digest', 'mirror:desktop:draft:now']);
    expect(outside.reason).toContain('never sent');
    const inside = await plan('inside-team');
    expect(inside.draftOnly).toBe(false);
    expect(inside.deliveries.every(step => step.action === 'send')).toBe(true);
    // No allowlist readable: fail closed to a draft.
    rmSync(join(configDir, 'agent-network.toml'));
    expect((await plan('inside-team')).draftOnly).toBe(true);
  });

  it('every update, channel and rule change keeps one thread id, and the same input gives the same bytes', async () => {
    const seen = new Set<string>();
    const names = readdirSync(resolve(process.cwd(), 'test/fixtures/notify-route')).map(file => file.replace(/\.json$/, ''));
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      const p = await plan(name);
      const first = stdout;
      for (const step of p.deliveries) seen.add(step.threadId);
      seen.add(p.threadId);
      await plan(name);
      expect(stdout).toBe(first);
    }
    setNotifyRule('decision', 'email');
    const moved = await plan('decision', '--unavailable', 'email');
    expect(steps(moved)).toEqual(['primary:desktop:send:now']);
    seen.add(moved.threadId);
    expect([...seen]).toEqual([OWNER_THREAD_ID]);
    expect(Object.keys(moved)).toEqual(['schema', 'version', 'sent', 'updateId', 'threadId', 'type', 'rule', 'status', 'text',
      'recipient', 'insideTeam', 'draftOnly', 'replyFormat', 'rulesSource', 'deliveries', 'reason']);
  });

  it('prints plain words by default and refuses a missing or non-object file', async () => {
    expect(await run('route', fixture('decision'))).toBe(0);
    expect(stdout).toContain('decision (BLOCKED) → imessage (send, now), desktop (send, now). Nothing sent.');
    expect(stdout).toContain('Reply with one word: YES or NO.');
    expect(await run('route', join(configDir, 'missing.json'))).toBe(2);
    writeFileSync(join(configDir, 'list.json'), '[]');
    expect(await run('route', join(configDir, 'list.json'), '--json')).toBe(2);
    expect(stderr).toContain('usage: phm notify route <update.json> [--json]');
  });
});

describe('notify rules', () => {
  const view = () => JSON.parse(stdout) as NotifyRulesView;
  const channels = (v: NotifyRulesView) => Object.fromEntries(v.rules.map(row => [row.type, row.channel]));
  const defaults = { decision: 'imessage', incident: 'imessage', 'texts-digest': 'imessage', digest: 'email', shipped: 'email', fyi: 'desktop' };

  it('shows the defaults when the rules file is missing', async () => {
    expect(await run('rules', '--json')).toBe(0);
    expect(view()).toMatchObject({ schema: 'phantom.notify.rules.v1', version: 1, source: 'defaults', problem: null, mirror: 'desktop' });
    expect(channels(view())).toEqual(defaults);
    expect(view().rules.every(row => row.isDefault)).toBe(true);
    expect(await run('rules')).toBe(0);
    expect(stdout).toContain('Decisions and approvals → iMessage. Now. Reply YES or NO.');
  });

  it('set changes one rule, and routing follows it', async () => {
    expect(await run('rules', 'set', 'shipped', 'imessage', '--json')).toBe(0);
    expect(view()).toMatchObject({ source: 'file', problem: null });
    expect(channels(view())).toEqual({ ...defaults, shipped: 'imessage' });
    expect(JSON.parse(readFileSync(rulesFile, 'utf8'))).toEqual({ version: 1, rules: { shipped: 'imessage' } });
    const p = await plan('shipped');
    expect(p.rulesSource).toBe('file');
    expect(steps(p)).toEqual(['primary:imessage:send:next-digest', 'mirror:desktop:send:now']);
  });

  it('a broken file or entry falls back to the defaults and says so', () => {
    mkdirSync(join(configDir, 'comms'), { recursive: true });
    writeFileSync(rulesFile, '{not json');
    expect(readNotifyRules()).toMatchObject({ source: 'defaults', problem: expect.stringContaining('defaults apply') });
    writeFileSync(rulesFile, JSON.stringify({ version: 1, rules: { fyi: 'email', decision: 'pager' } }));
    const partial = readNotifyRules();
    expect(channels(partial)).toEqual({ ...defaults, fyi: 'email' });
    expect(partial.problem).toContain('decision');
  });

  it.each([[['set']], [['set', 'poem', 'email']], [['set', 'fyi', 'slack']], [['bogus']]])('refuses %j', async (args) => {
    expect(await run('rules', ...args)).toBe(2);
    expect(stderr).toContain('usage: phm notify rules');
    expect(existsSync(rulesFile)).toBe(false);
  });
});

describe('/api/notify/rules', () => {
  const servers: WebServerHandle[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
  async function call(allowDispatch: boolean, method: 'GET' | 'POST', body?: unknown, token?: string) {
    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch });
    servers.push(h);
    const res = await fetch(`http://127.0.0.1:${h.port}/api/notify/rules`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: method === 'GET' ? readAuthHeaders(h.port) : { 'Content-Type': 'application/json', 'x-ashlr-token': token ?? h.token },
    });
    return { status: res.status, body: await res.json() as NotifyRulesView };
  }

  it('reads the same view the CLI prints and edits one rule behind the mutation gate', async () => {
    const got = await call(true, 'GET');
    expect(got.status).toBe(200);
    expect(got.body).toEqual(readNotifyRules());
    expect((await call(true, 'POST', { type: 'fyi', channel: 'email' }, 'wrong')).status).toBe(401);
    expect((await call(true, 'POST', { type: 'fyi', channel: 'pager' })).status).toBe(400);
    expect((await call(true, 'POST', { type: 'fyi', channel: 'email', extra: 1 })).status).toBe(400);
    expect((await call(false, 'POST', { type: 'fyi', channel: 'email' })).status).toBe(404);
    expect(existsSync(rulesFile)).toBe(false);
    const ok = await call(true, 'POST', { type: 'fyi', channel: 'email' });
    expect(ok.status).toBe(200);
    expect(ok.body.rules.find(row => row.type === 'fyi')).toMatchObject({ channel: 'email', isDefault: false });
    expect(ok.body).toEqual(readNotifyRules());
  });
});
