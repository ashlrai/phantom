/** Real private metadata round trips; no provider, credential or paid calls. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createProactiveProfilesStore, getProactiveProfilesStore, type ProactiveProfilesStore } from '../src/core/proactive/profiles.js';
import { createProactiveAgentsApi } from '../src/core/verse/proactive-agents-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createProactiveProfile, deleteProactiveProfile, listProactiveProfiles, updateProactiveProfile } from '../src/core/proactive/tools.js';
import { callNativeTool, nativeToolSafety } from '../src/core/mcp-native.js';

let root: string, directory: string, store: ProactiveProfilesStore;
let previousHome: string | undefined;
const input = { identity: { provider: 'openai-dot', accountId: 'account-a', agentId: 'dot-a' }, displayName: 'Scout' };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phantom-proactive-test-'));
  directory = join(root, 'proactive-agents');
  previousHome = process.env['ASHLR_HOME']; process.env['ASHLR_HOME'] = root;
  store = createProactiveProfilesStore({ directory: () => directory });
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = previousHome;
  await rm(root, { recursive: true, force: true });
});

describe('private proactive profiles', () => {
  it('persists identity and editable details across fresh stores without claiming capability or funding', async () => {
    expect(await store.list()).toEqual({ schemaVersion: 1, profiles: [] });
    const profile = await store.create({ ...input, responsibility: 'Find useful engineering work.',
      computer: { kind: 'hosted', label: 'Scout computer', providerComputerId: 'pc-a' },
      services: [{ id: 'gmail', label: 'Gmail' }],
      fundingReference: { kind: 'subscription', accountId: 'account-a', poolId: null } });
    const fresh = createProactiveProfilesStore({ directory: () => directory });
    expect((await fresh.list()).profiles).toEqual([profile]);
    expect(profile.connection).toBe('configured'); expect(profile.lastRun).toBeNull();
    expect(profile.operations.dispatch.state).toBe('unverified');
    expect(Object.values(profile.operations).every(operation => operation.verifiedAt === null)).toBe(true);
    expect(profile.fundingReference).not.toHaveProperty('balance');
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, 'profiles.json'))).mode & 0o777).toBe(0o600);
    }
  });
  it('isolates provider/account/agent identities and refuses duplicate identity or foreign funding references', async () => {
    const a = await store.create(input);
    const b = await store.create({ ...input, identity: { ...input.identity, accountId: 'account-b' } });
    const c = await store.create({ ...input, identity: { ...input.identity, provider: 'grok-bot' } });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    await expect(store.create(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.create({ ...input, fundingReference: { kind: 'promotional-api', accountId: 'account-b', poolId: 'pool' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.create({ ...input, fundingReference: { kind: 'subscription', accountId: 'account-a', poolId: null, balance: 200 } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('supports arbitrary providers, several accounts and agents, with declared capabilities and bounded preferences', async () => {
    const identity = { provider: 'acme-companion', accountId: 'company-a', agentId: 'assistant-a' };
    const profile = await store.create({ identity, displayName: 'Generalist', capabilityIds: ['research', 'email-drafting'],
      preferences: { priority: 70, maxConcurrent: 2, projectBindingIds: ['client-project-a'] } });
    const account = await store.create({ identity: { ...identity, accountId: 'company-b' }, displayName: 'Other account' });
    const agent = await store.create({ identity: { ...identity, agentId: 'assistant-b' }, displayName: 'Other agent' });
    expect(new Set([profile.id, account.id, agent.id]).size).toBe(3);
    expect(profile.capabilityIds).toEqual(['research', 'email-drafting']);
    expect(profile.capabilityVerification).toBe('declared-unverified');
    expect(profile.preferences).toEqual({ priority: 70, maxConcurrent: 2, projectBindingIds: ['client-project-a'] });
    expect(account.preferences).toEqual({ priority: 50, maxConcurrent: 1, projectBindingIds: [] });
    expect(account.capabilityIds).toEqual([]);
    expect(profile.connection).toBe('configured'); expect(profile.operations.result.state).toBe('unsupported');
    const updated = await store.update(profile.id, { expectedVersion: 1, preferences: { priority: 0 }, capabilityIds: ['engineering'] });
    expect(updated.preferences).toEqual({ priority: 0, maxConcurrent: 1, projectBindingIds: [] });
    expect(updated.identity).toEqual(identity);
    await expect(store.update(profile.id, { expectedVersion: 1, capabilityIds: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rejects invalid provider/capability slugs, duplicates, unbounded preferences and credential references', async () => {
    for (const provider of ['Acme', 'acme.bot', 'acme--bot', '-acme', 'a'.repeat(65), 'acme\nprovider']) {
      await expect(store.create({ ...input, identity: { ...input.identity, provider } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    for (const patch of [{ capabilityIds: ['research', 'research'] }, { capabilityIds: ['Research'] },
      { capabilityIds: Array.from({ length: 33 }, (_, index) => `cap-${index}`) },
      { capabilityIds: [`sk-${'ab1'.repeat(16)}`] }, { preferences: { priority: 101 } },
      { preferences: { priority: 1.5 } }, { preferences: { maxConcurrent: 0 } }, { preferences: { maxConcurrent: 33 } },
      { preferences: { projectBindingIds: ['same', 'same'] } }, { preferences: { projectBindingIds: ['bad\u0000id'] } },
      { preferences: { projectBindingIds: [`sk-${'Ab1c'.repeat(16)}`] } }, { preferences: { authority: true } }]) {
      await expect(store.create({ ...input, ...patch })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect((await store.list()).profiles).toEqual([]);
  });
  it('hydrates existing v1 records without rewriting storage, changing stable IDs or promoting capabilities', async () => {
    const created = await store.create({ ...input, identity: { ...input.identity, accountId: 'a'.repeat(64) },
      fundingReference: { kind: 'subscription', accountId: 'a'.repeat(64), poolId: 'b'.repeat(64) } }), file = join(directory, 'profiles.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    delete saved.profiles[0].capabilityIds; delete saved.profiles[0].capabilityVerification; delete saved.profiles[0].preferences;
    const legacy = JSON.stringify(saved); await writeFile(file, legacy);
    const migrated = (await createProactiveProfilesStore({ directory: () => directory }).list()).profiles[0]!;
    expect(migrated.id).toBe(created.id); expect(migrated.version).toBe(1);
    expect(migrated.capabilityIds).toEqual([]); expect(migrated.capabilityVerification).toBe('declared-unverified');
    expect(migrated.preferences).toEqual({ priority: 50, maxConcurrent: 1, projectBindingIds: [] });
    expect(await readFile(file, 'utf8')).toBe(legacy);
    const updated = await store.update(migrated.id, { expectedVersion: 1, capabilityIds: ['review'] });
    expect(updated.id).toBe(created.id); expect(updated.version).toBe(2);
    saved.profiles[0].capabilityVerification = 'verified'; await writeFile(file, JSON.stringify(saved));
    await expect(store.list()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('uses versions for edits/deletes and preserves both accounts during concurrent writes', async () => {
    const profile = await store.create(input);
    const other = createProactiveProfilesStore({ directory: () => directory });
    const outcomes = await Promise.allSettled([
      store.update(profile.id, { expectedVersion: 1, displayName: 'First' }),
      other.update(profile.id, { expectedVersion: 1, displayName: 'Second' }),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.code).toBe('CONFLICT');
    expect((await other.list()).profiles[0]?.version).toBe(2);
    await expect(store.remove(profile.id, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    await store.remove(profile.id, 2); expect((await store.list()).profiles).toEqual([]);
  });
  it('rejects forged qualification, mutable identity, duplicate services and invalid metadata', async () => {
    const profile = await store.create(input);
    for (const patch of [{ identity: input.identity }, { operations: { dispatch: { state: 'verified' } } },
      { lastRun: { state: 'result-verified' } }, { services: [{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }] },
      { avatar: { color: 'url(https://example.invalid)', variant: 'classic' } }, { enabled: 'true' }]) {
      await expect(store.update(profile.id, { expectedVersion: 1, ...patch })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect((await store.list()).profiles[0]?.version).toBe(1);
  });
  it('preserves corrupt data and refuses symlink or public storage', async () => {
    await store.create(input);
    const file = join(directory, 'profiles.json');
    await writeFile(file, '{corrupt', { mode: 0o600 });
    await expect(store.create({ ...input, identity: { ...input.identity, agentId: 'new' } })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(await readFile(file, 'utf8')).toBe('{corrupt');
    if (process.platform !== 'win32') {
      await rm(file); await symlink(join(root, 'outside'), file);
      await expect(store.list()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await rm(file); await chmod(directory, 0o755);
      await expect(store.list()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    }
  });
  it('derives current readiness notes from source while refusing stored capability promotion', async () => {
    await store.create(input); const file = join(directory, 'profiles.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.profiles[0].operations.dispatch.note = 'Older source note';
    await writeFile(file, JSON.stringify(saved));
    expect((await store.list()).profiles[0]?.operations.dispatch.note).toContain('plugin events');
    saved.profiles[0].operations.dispatch.state = 'verified';
    await writeFile(file, JSON.stringify(saved));
    await expect(store.list()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

async function request(path: string, method = 'GET', body: unknown = undefined, options: { token?: string; allowDispatch?: boolean; raw?: string } = {}) {
  const req = Readable.from([options.raw ?? JSON.stringify(body ?? {})]) as unknown as IncomingMessage;
  req.url = path; req.headers = { 'content-type': 'application/json', 'x-ashlr-token': options.token ?? 'test-token' };
  let status = 0, result: unknown;
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; }, end(text: string) { result = JSON.parse(text); } } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: 'test-token', allowDispatch: options.allowDispatch ?? true } as VerseApiContext;
  const handled = await createProactiveAgentsApi(() => store)(ctx, req, res, path.split('?')[0]!, method);
  return { status, result, handled };
}
describe('proactive profile API and native tools', () => {
  const base = '/api/verse/proactive-agents';
  it('round trips create, fresh read, CAS update and delete through the API', async () => {
    const created = await request(base, 'POST', input); expect(created.status).toBe(201);
    const profile = (created.result as { profile: { id: string } }).profile;
    expect((await request(base)).status).toBe(200);
    expect((await request(`${base}/${profile.id}`, 'POST', { expectedVersion: 1, enabled: false })).status).toBe(200);
    expect((await request(`${base}/${profile.id}`, 'POST', { expectedVersion: 1, displayName: 'Stale' })).status).toBe(409);
    expect((await request(`${base}/${profile.id}/delete`, 'POST', { expectedVersion: 2 })).status).toBe(200);
    expect((await store.list()).profiles).toEqual([]);
  });
  it('keeps existing route/token gates and rejects unsupported query/body/verification fields', async () => {
    expect((await request(base, 'POST', input, { allowDispatch: false })).status).toBe(404);
    expect((await request(base, 'POST', input, { token: 'wrong' })).status).toBe(401);
    expect((await request(`${base}?unknown=1`)).status).toBe(400);
    expect((await request(base, 'POST', undefined, { raw: '{' })).status).toBe(400);
    expect((await request(base, 'POST', { ...input, operations: {} })).status).toBe(400);
    expect((await request(`${base}/dispatch`, 'POST', {})).status).toBe(404);
    expect((await request(`${base}-other`)).handled).toBe(false);
    expect((await store.list()).profiles).toEqual([]);
  });
  it('paginates real native Unicode output by full scrubbed UTF-8 bytes without missing or repeating identities', async () => {
    const accountId = '漢'.repeat(256), identities = new Set<string>();
    for (let index = 0; index < 10; index++) {
      const profile = await createProactiveProfile({ profile: {
        identity: { provider: 'openai-dot', accountId, agentId: '語'.repeat(254) + `${index}` },
        displayName: '名'.repeat(120), responsibility: '事'.repeat(4000),
        computer: { kind: 'hosted', label: '機'.repeat(120), providerComputerId: '電'.repeat(256) },
        fundingReference: { kind: 'subscription', accountId, poolId: '資'.repeat(256) },
      } }) as { profile: { id: string } };
      identities.add(profile.profile.id);
    }
    const seen: string[] = []; let offset = 0, pages = 0;
    while (true) {
      const response = await callNativeTool('phm_proactive_agents_list', { offset, limit: 50 });
      expect(response.isError).not.toBe(true);
      const text = response.content[0]!.text;
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
      expect(text).not.toContain('output truncated');
      const page = JSON.parse(text) as { profiles: Array<{ id: string }>; total: number; nextOffset: number | null };
      expect(page.total).toBe(identities.size); expect(page.profiles.length).toBeGreaterThan(0);
      seen.push(...page.profiles.map(profile => profile.id)); pages++;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBe(offset + page.profiles.length); expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset; expect(pages).toBeLessThanOrEqual(10);
    }
    expect(pages).toBeGreaterThan(1); expect(seen).toHaveLength(10); expect(new Set(seen)).toEqual(identities);
  });
  it('fits the actual scrubbed pretty envelope and safely returns one maximum summary', async () => {
    const secret = `sk-${'Ab1c'.repeat(24)}`, created = await createProactiveProfile({ profile: { ...input,
      responsibility: `Useful context ${secret}`, computer: { kind: 'hosted', label: '機'.repeat(120), providerComputerId: '電'.repeat(256) } } }) as { profile: { id: string } };
    const response = await callNativeTool('phm_proactive_agents_list', { limit: 1 });
    const text = response.content[0]!.text, page = JSON.parse(text);
    expect(response.isError).not.toBe(true); expect(text).not.toContain(secret);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(page.profiles.map((profile: { id: string }) => profile.id)).toEqual([created.profile.id]);
    expect(page.nextOffset).toBeNull();
    expect((await getProactiveProfilesStore().list()).profiles[0]!.responsibility).toContain(secret);
  });
  it('shares saved metadata and stale-write behavior through native tools with explicit read/write safety', async () => {
    expect(nativeToolSafety('phm_proactive_agents_list')).toBe('read');
    for (const verb of ['create', 'update', 'delete']) expect(nativeToolSafety(`phm_proactive_agents_${verb}`)).toBe('append');
    const created = await createProactiveProfile({ profile: input }) as { profile: { id: string } };
    await createProactiveProfile({ profile: { ...input, identity: { ...input.identity, accountId: 'account-b' } } });
    const page = await listProactiveProfiles({ accountId: 'account-a', limit: 1 }) as { total: number; profiles: Array<{ id: string }> };
    expect(page.total).toBe(1); expect(page.profiles[0]?.id).toBe(created.profile.id);
    await expect(listProactiveProfiles({ dispatch: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await updateProactiveProfile({ id: created.profile.id, patch: { expectedVersion: 1, displayName: 'New name' } });
    await expect(deleteProactiveProfile({ id: created.profile.id, expectedVersion: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await deleteProactiveProfile({ id: created.profile.id, expectedVersion: 2 });
    expect((await getProactiveProfilesStore().list()).profiles[0]?.identity.accountId).toBe('account-b');
  });
  it('filters arbitrary providers through native tools and returns declared capabilities without claiming qualification', async () => {
    const created = await createProactiveProfile({ profile: { ...input, identity: { ...input.identity, provider: 'custom-cloud' },
      capabilityIds: ['research'], preferences: { maxConcurrent: 3 } } }) as { profile: { id: string } };
    const page = await listProactiveProfiles({ provider: 'custom-cloud' }) as { total: number; profiles: Array<{ id: string; capabilityVerification: string; preferences: { maxConcurrent: number } }> };
    expect(page.total).toBe(1); expect(page.profiles[0]?.id).toBe(created.profile.id);
    expect(page.profiles[0]?.capabilityVerification).toBe('declared-unverified');
    expect(page.profiles[0]?.preferences.maxConcurrent).toBe(3);
    await expect(listProactiveProfiles({ provider: 'invalid provider' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
