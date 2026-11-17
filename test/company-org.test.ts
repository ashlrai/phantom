import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readCompanyOrg } from '../src/core/org/company-view.js';

const dirs: string[] = [];
const now = Date.parse('2026-11-15T12:00:00Z');
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'company-org-')); dirs.push(root);
  const file = join(root, 'org.toml'), dir = join(root, 'joins');
  await writeFile(file, await readFile('docs/examples/org.toml'));
  await mkdir(dir);
  const put = async (member: string, machine: string, lanes: { lane: string; share: number }[], extra = {}) => {
    await writeFile(join(dir, `${member}.${machine}.json`), JSON.stringify({ v: 1, member, machine, lanes, joinedAt: '2026-11-14T12:00:00Z', ...extra }));
  };
  return { file, dir, put, read: () => readCompanyOrg({ file, dir, now }) };
}

it('counts only positive, declared opt-ins, deduplicates lanes and returns no member-private metadata', async () => {
  const f = await fixture();
  await f.put('mason-wyatt', 'mason-mac', [{ lane: 'claude', share: 100 }, { lane: 'codex-personal', share: 0 }]);
  await f.put('evan-deloria', 'evan-mac', [{ lane: 'claude', share: 10 }], { privateMail: 'PRIVATE-MAIL', privateUsage: 'PRIVATE-USAGE' });
  await f.put('mason-scofield', 'sco-mac', [{ lane: 'codex-personal', share: 31 }, { lane: 'devin', share: 10 }]);
  await f.put('unknown', 'other', [{ lane: 'zai', share: 10 }]);
  await f.put('mason-wyatt', 'foreign-machine', [{ lane: 'zai', share: 10 }]);
  const view = await f.read();
  expect(view).toEqual({ schema: 'company.org.v1', generatedAt: new Date(now).toISOString(),
    sources: { org: 'available', joins: 'available' }, members: 3, contributingMembers: 2, contributingLanes: 1 });
  for (const privateText of ['PRIVATE-', 'mason', 'evan', f.file, f.dir, 'share', 'pool']) expect(JSON.stringify(view)).not.toContain(privateText);
});

it('does not equate declared capacity with contribution; no join records means zero recorded opt-ins', async () => {
  const f = await fixture();
  expect(await f.read()).toMatchObject({ members: 3, contributingMembers: 0, contributingLanes: 0 });
  await rm(f.dir, { recursive: true });
  expect(await f.read()).toMatchObject({ sources: { org: 'available', joins: 'missing' }, members: 3, contributingMembers: 0, contributingLanes: 0 });
});

it('keeps missing, invalid and empty org metadata unknown; never leaks invalid input diagnostics', async () => {
  const f = await fixture();
  for (const text of ['', 'version=1\nleader="nobody"\nmembers=[]', 'PRIVATE-INVALID-TOML']) {
    await writeFile(f.file, text);
    expect(await f.read()).toMatchObject({ sources: { org: 'invalid' }, members: null, contributingMembers: null, contributingLanes: null });
  }
  await rm(f.file);
  expect(await f.read()).toMatchObject({ sources: { org: 'unavailable' }, members: null });
});

it('retains known membership with unknown contributions for unreadable or malformed join inventories', async () => {
  const f = await fixture();
  await writeFile(join(f.dir, 'bad.json'), 'PRIVATE-INVALID-JSON');
  expect(await f.read()).toMatchObject({ sources: { org: 'available', joins: 'invalid' }, members: 3, contributingLanes: null });
  await rm(f.dir, { recursive: true }); await writeFile(f.dir, 'not a directory');
  expect(await f.read()).toMatchObject({ sources: { joins: 'unavailable' }, members: 3, contributingLanes: null });
});

it('does not count future or mismatched joins and refuses malformed lane shares', async () => {
  const f = await fixture();
  await f.put('mason-wyatt', 'mason-mac', [{ lane: 'claude', share: 100 }], { joinedAt: '2027-01-01T00:00:00Z' });
  expect(await f.read()).toMatchObject({ contributingLanes: 0 });
  const copied = JSON.parse(await readFile(join(f.dir, 'mason-wyatt.mason-mac.json'), 'utf8'));
  copied.joinedAt = '2026-11-14T12:00:00Z';
  await writeFile(join(f.dir, 'copied.json'), JSON.stringify(copied));
  expect(await f.read()).toMatchObject({ contributingLanes: 0 });
  await f.put('mason-wyatt', 'mason-mac', [{ lane: 'claude', share: -1 }]);
  expect(await f.read()).toMatchObject({ sources: { joins: 'invalid' }, contributingLanes: null });
});

it('rejects oversized org metadata and refuses symlinked join files', async () => {
  const f = await fixture();
  await symlink(f.file, join(f.dir, 'linked.json'));
  expect(await f.read()).toMatchObject({ sources: { joins: 'unavailable' }, members: 3, contributingLanes: null });
  await writeFile(f.file, '#'.repeat(256 * 1024 + 1));
  expect(await f.read()).toMatchObject({ sources: { org: 'invalid' }, members: null });
});
