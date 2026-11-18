import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BOT_TEMPLATES, BotTemplateError, createBotFromTemplate, listBots, listBotTemplates } from '../src/core/agents/bot-templates.js';
import { readAgentProfile } from '../src/core/agents/agent-profile.js';
import { readAutomations } from '../src/core/automations/store.js';
import { assertMetadata } from '../src/core/connectors/profile.js';
import { handleBotTemplates } from '../src/api/bot-templates.js';
import { handleApi } from '../src/core/web/api.js';
import { defaultConfig } from '../src/core/config.js';
import * as seatRoster from '../src/core/bots/seats.js';

let n = 0;
const fresh = () => `bot-${n++}`;
const dirOf = (id: string) => join(homedir(), '.phantom', 'bots', id);

describe('bot templates', () => {
  it('ships three starter templates with avatar, role, memory seed, tasks, crons and channels', () => {
    expect(BOT_TEMPLATES.map(t => t.id)).toEqual(['pr-reviewer', 'release-scribe', 'ci-watchdog']);
    for (const t of BOT_TEMPLATES) {
      expect(t.avatar.glyph.length).toBeGreaterThan(0);
      expect(t.memorySeed.length).toBeGreaterThan(0);
      expect(t.tasks.length).toBeGreaterThan(0);
      expect(t.crons.length).toBeGreaterThan(0);
      expect(t.channels.length).toBeGreaterThan(0);
      for (const c of t.crons) expect(c.input.enabled).toBe(false);
      expect(() => assertMetadata(JSON.stringify(t))).not.toThrow();
    }
    expect(listBotTemplates()).toHaveLength(3);
  });

  it('creates the profile, private folder and disabled automations from a template', async () => {
    const id = fresh();
    const { bot, profileVersion, files } = await createBotFromTemplate({ templateId: 'ci-watchdog', id, name: 'Main CI' });
    expect(profileVersion).toBe(1);
    expect(bot).toMatchObject({ id, name: 'Main CI', templateId: 'ci-watchdog', role: 'implementer' });
    expect(files).toEqual(['bot.json', 'doctrine.md', 'memory-seed.md']);
    const profile = await readAgentProfile(id);
    expect(profile).toMatchObject({ displayName: 'Main CI', channels: ['bus', 'slack'], doctrine: `bots/${id}/doctrine.md` });
    // No authority: drafts only, limits still open.
    expect(profile.policy).toMatchObject({ send: 'drafts-only', perMessageApproval: true, limitsTodo: true });
    expect(readFileSync(join(dirOf(id), 'memory-seed.md'), 'utf8')).toContain('flaky test');
    expect(statSync(join(dirOf(id), 'bot.json')).mode & 0o777).toBe(0o600);
    const automations = (await readAutomations()).automations.filter(a => bot.automations.includes(a.id));
    expect(automations).toHaveLength(1);
    expect(automations[0]).toMatchObject({ enabled: false, lane: 'leader-review', spendCapUsd: 0 });
    expect((await listBots()).map(b => b.id)).toContain(id);
  });

  it('refuses a taken id without touching the existing bot', async () => {
    const id = fresh();
    await createBotFromTemplate({ templateId: 'pr-reviewer', id });
    const before = readFileSync(join(dirOf(id), 'bot.json'), 'utf8');
    await expect(createBotFromTemplate({ templateId: 'release-scribe', id })).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(dirOf(id), 'bot.json'), 'utf8')).toBe(before);
    expect((await readAgentProfile(id)).version).toBe(1);
  });

  it('refuses an existing agent profile and leaves no folder behind', async () => {
    const id = fresh();
    const { writeAgentProfile } = await import('../src/core/agents/agent-profile.js');
    await writeAgentProfile({ id, displayName: 'Hand made', doctrine: 'd.md' });
    await expect(createBotFromTemplate({ templateId: 'pr-reviewer', id })).rejects.toMatchObject({ status: 409 });
    expect(existsSync(dirOf(id))).toBe(false);
    expect((await readAgentProfile(id)).displayName).toBe('Hand made');
  });

  it('rejects unknown templates and bad ids or names before writing anything', async () => {
    await expect(createBotFromTemplate({ templateId: 'nope', id: fresh() })).rejects.toMatchObject({ status: 404 });
    for (const id of ['', 'A', 'x', '../evil', 'a/b', 'has space', 'a'.repeat(25), '1abc']) {
      await expect(createBotFromTemplate({ templateId: 'pr-reviewer', id })).rejects.toBeInstanceOf(BotTemplateError);
      expect(existsSync(join(homedir(), '.phantom', 'bots', id || '.'))).toBe(id === '');
    }
    const id = fresh();
    await expect(createBotFromTemplate({ templateId: 'pr-reviewer', id, name: 'bad\nname' })).rejects.toBeInstanceOf(BotTemplateError);
    await expect(createBotFromTemplate({ templateId: 'pr-reviewer', id, name: `sk-ant-${'a'.repeat(30)}` })).rejects.toBeInstanceOf(BotTemplateError);
    expect(existsSync(dirOf(id))).toBe(false);
  });

  it('rolls back the folder, profile and earlier automations when a cron cannot be saved', async () => {
    const id = fresh();
    // Pre-claim the first cron id so saveAutomation(create) refuses it.
    const { saveAutomation } = await import('../src/core/automations/store.js');
    const tpl = BOT_TEMPLATES[0]!;
    await saveAutomation({ ...tpl.crons[0]!.input, id: `au_bot-${id}-${tpl.crons[0]!.key}` }, { mode: 'create' });
    await expect(createBotFromTemplate({ templateId: tpl.id, id })).rejects.toBeInstanceOf(BotTemplateError);
    expect(existsSync(dirOf(id))).toBe(false);
    await expect(readAgentProfile(id)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(existsSync(join(homedir(), '.phantom', 'agents', `${id}.versions`))).toBe(false);
    // The pre-existing automation is not ours to remove.
    expect((await readAutomations()).automations.some(a => a.id === `au_bot-${id}-${tpl.crons[0]!.key}`)).toBe(true);
  });
});

async function call(method: string, url: string, body?: unknown, opts: { token?: string; allowDispatch?: boolean } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage;
  req.url = url; req.method = method;
  req.headers = { 'x-ashlr-token': opts.token ?? 'test-mutation', 'content-type': 'application/json' };
  let status = 0; let result = '';
  const res = { setHeader: vi.fn(), writeHead: (c: number) => { status = c; }, end: (t: string) => { result = t; } } as unknown as ServerResponse;
  await handleApi(req, res, defaultConfig(), { token: 'test-mutation', allowDispatch: opts.allowDispatch ?? true, botTemplatesApi: handleBotTemplates });
  return { status, body: JSON.parse(result) as Record<string, any> };
}

describe('bot template API', () => {
  it('serves a read-only external seat roster without requiring dispatch or a mutation token', async () => {
    const result = await call('GET', '/api/bots/seats', undefined, { allowDispatch: false, token: 'wrong' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ schema: 'phantom-bot-seats.v1', seats: [] });
    expect((await call('POST', '/api/bots/seats', {})).status).toBe(405);
  });
  it('returns a value-free error when seat configuration is unavailable', async () => {
    const read = vi.spyOn(seatRoster, 'listSeats').mockRejectedValueOnce(new Error(`sk-${'A'.repeat(32)}`));
    try {
      const result = await call('GET', '/api/bots/seats');
      expect(result).toEqual({ status: 503, body: { error: 'Bot seats unavailable.' } });
    } finally { read.mockRestore(); }
  });
  it('lists templates and creates a bot', async () => {
    const list = await call('GET', '/api/bots/templates');
    expect(list.status).toBe(200);
    expect(list.body.templates.map((t: { id: string }) => t.id)).toEqual(['pr-reviewer', 'release-scribe', 'ci-watchdog']);
    expect(JSON.stringify(list.body)).not.toContain('doctrine');
    const id = fresh();
    const made = await call('POST', '/api/bots', { templateId: 'release-scribe', id });
    expect(made.status).toBe(201);
    expect(made.body.bot).toMatchObject({ id, role: 'researcher' });
    expect((await call('GET', '/api/bots')).body.bots.map((b: { id: string }) => b.id)).toContain(id);
    expect((await call('POST', '/api/bots', { templateId: 'release-scribe', id })).status).toBe(409);
  });

  it('enforces dispatch, token, shape and template gates', async () => {
    const id = fresh();
    expect((await call('POST', '/api/bots', { templateId: 'pr-reviewer', id }, { allowDispatch: false })).status).toBe(404);
    expect((await call('POST', '/api/bots', { templateId: 'pr-reviewer', id }, { token: 'wrong' })).status).toBe(401);
    expect((await call('POST', '/api/bots', { templateId: 'pr-reviewer', id, extra: 1 })).status).toBe(400);
    expect((await call('POST', '/api/bots', { templateId: 5, id })).status).toBe(400);
    expect((await call('POST', '/api/bots', { templateId: 'nope', id })).status).toBe(404);
    expect((await call('DELETE', '/api/bots')).status).toBe(405);
    expect(existsSync(dirOf(id))).toBe(false);
  });
});
