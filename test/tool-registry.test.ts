import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolMesh } from '../src/core/connectors/mesh.js';
import { updateProfile, validateProfile } from '../src/core/connectors/profile.js';
import { createTool, discoverTools, invokeTool, readRegistry, registryPath, removeTool, revokeTool } from '../src/core/connectors/registry.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'registry-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const skill = { kind: 'skill' as const, id: 'summarize', description: 'Summarize a topic', createdBy: 'agent-a', params: ['topic'], template: 'Summarize {{topic}} briefly.' };

describe('tool registry', () => {
  it('lets one agent create a tool that another lane discovers and invokes', async () => {
    await createTool({ ...skill, lanes: ['work'] }, home);
    expect((await discoverTools(home, 'work')).map(t => t.id)).toEqual(['summarize']);
    expect(await discoverTools(home, 'other')).toEqual([]);
    const out = await invokeTool('summarize', 'work', { topic: 'x {{topic}}' }, home);
    expect(out).toMatchObject({ untrusted: true, createdBy: 'agent-a', text: 'Summarize x {{topic}} briefly.' });
    expect((await stat(registryPath(home))).mode & 0o777).toBe(0o600);
    await expect(invokeTool('summarize', 'other', { topic: 'x' }, home)).rejects.toThrow('lane');
  });

  it('revocation removes discovery and invocation; remove deletes the entry', async () => {
    await createTool(skill, home);
    await revokeTool('summarize', 'unsafe', home);
    expect(await discoverTools(home)).toEqual([]);
    await expect(invokeTool('summarize', 'work', { topic: 'x' }, home)).rejects.toThrow('revoked');
    expect((await readRegistry(home)).tools[0]?.status).toBe('revoked');
    await removeTool('summarize', home);
    expect((await readRegistry(home)).tools).toEqual([]);
  });

  it('rejects invalid, colliding, secret-bearing and undeclared-placeholder entries', async () => {
    await expect(createTool({ ...skill, id: 'phm_team_view' }, home)).rejects.toThrow('native');
    await expect(createTool({ ...skill, template: 'Use {{other}}' }, home)).rejects.toThrow('placeholder');
    await expect(createTool({ ...skill, template: 'key sk-a' + 'nt-abcde' + 'fghijklm' + 'nopqrstu' + 'vwxyz012' + '3' }, home)).rejects.toThrow('Secret');
    await expect(createTool({ ...skill, status: 'active', extra: 1 } as never, home)).rejects.toThrow('Invalid');
    await createTool(skill, home);
    await expect(createTool(skill, home)).rejects.toThrow('Duplicate');
    await expect(invokeTool('summarize', 'work', { topic: 'sk-ant-a' + 'bcdefghi' + 'jklmnopq' + 'rstuvwxy' + 'z0123' }, home)).rejects.toThrow('Secret');
    await expect(invokeTool('summarize', 'work', {}, home)).rejects.toThrow('exactly');
  });

  it('ignores caller-supplied status and revocation fields', async () => {
    const t = await createTool({ ...skill, status: 'revoked', revocation: { at: 'x', reason: 'y' } } as never, home);
    expect(t.status).toBe('active');
    expect(t.revocation).toBeUndefined();
  });

  it('connector-call needs a cli connector and still routes through the denied runner', async () => {
    const call = { kind: 'connector-call' as const, id: 'repo-list', description: 'List repos', createdBy: 'agent-b', connector: 'gh', selectors: { scope: 'read', tool: 'agent-b', lane: 'work' }, params: ['owner'], argTemplate: ['repo', 'list', '{{owner}}'] };
    await expect(createTool(call, home)).rejects.toThrow('cli connector');
    await updateProfile(() => validateProfile({ version: 1, connectors: [{ id: 'gh', kind: 'cli', command: 'gh', scopes: ['read'], tools: ['agent-b'], lanes: ['work'] }] }), home);
    await createTool(call, home);
    await expect(invokeTool('repo-list', 'work', { owner: '--token' }, home)).rejects.toThrow('"-"');
    await expect(invokeTool('repo-list', 'work', { owner: 'acme' }, home)).rejects.toThrow('denied');
    await expect(createTool({ ...call, id: 'bad', argTemplate: [['--token', 'abc'].join('=')] }, home)).rejects.toThrow();
  });

  it('surfaces active registry tools, MCPs, CLIs and computer-use hooks in a lane-filtered mesh', async () => {
    await updateProfile(() => validateProfile({ version: 1, connectors: [
      { id: 'search', kind: 'mcp-http', url: 'https://example.com/mcp', lanes: ['work'] },
      { id: 'private', kind: 'cli', command: 'x', lanes: ['ops'] },
    ] }), home);
    await createTool(skill, home);
    const work = await buildToolMesh(home, '', 'work');
    expect(work.connectors.map(c => c.id)).toEqual(['search']);
    expect(work.capabilities.mcp).toEqual(['search']);
    expect(work.capabilities.webSearch.mcpConnectors).toEqual(['search']);
    expect(work.capabilities.computerUse.hooks.map(h => h.name)).toContain('ashlr_browser_task');
    expect(work.registry).toMatchObject([{ id: 'summarize', trust: 'agent-authored' }]);
    expect(JSON.stringify(work)).not.toContain('Summarize {{topic}}');
    expect((await buildToolMesh(home, '', 'ops')).capabilities.cli).toEqual(['private']);
  });
});
