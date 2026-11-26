import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorRequest, OperatorResult } from '../src/core/desktop/operator.js';
import { collectResourceEvidence } from '../src/core/usage/resource-live/evidence-collector.js';
import { antigravityAgentCheck, defaultResourceLiveSources } from '../src/core/usage/resource-live/sources.js';
import { readResourceEvidenceFile } from '../src/core/usage/resource-live/store.js';
import { cmdResourcesEvidence } from '../src/cli/resources-evidence.js';

describe('scheduled desktop resource evidence', () => {
  const at = Date.parse('2026-12-01T12:03:00Z');
  let now: number;
  let runsDir: string;
  let configPath: string;
  let text: Record<string, string>;
  const operator = vi.fn(async (request: OperatorRequest): Promise<OperatorResult> => {
    if (request.verb === 'windows') {
      return { ok: true, verb: 'windows', data: { windows: Object.keys(text).map(title => ({ title })) } };
    }
    if (request.verb === 'read' && request.window && text[request.window]) {
      return { ok: true, verb: 'read', data: { text: text[request.window], truncated: false } };
    }
    return { ok: false, verb: request.verb, code: 'denied', error: 'unavailable' };
  });
  const collect = () => collectResourceEvidence({ runsDir, configPath, now: () => now, operator });
  const configure = async (heads: Record<string, string>) => {
    const targets = Object.fromEntries(Object.entries(heads).map(([id, heading]) => [id, { app: 'Quota Viewer', window: id, heading }]));
    await writeFile(configPath, JSON.stringify({ schema: 'resource-evidence-targets.v1', targets }), { mode: 0o600 });
  };

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'resource-evidence-'));
    configPath = join(runsDir, 'targets.json');
    now = at;
    text = {};
    operator.mockClear();
  });
  afterEach(async () => { await rm(runsDir, { force: true, recursive: true }); });

  it('records an owner observation then replaces it with a complete visible reset bank', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const args = ['record', '--resource', 'codex-personal', '--resets', '2', '--source', 'owner-screenshot', '--runs-dir', runsDir, '--json'];
      expect(await cmdResourcesEvidence([...args, '--expires', '2026-12-01T22:31:00Z'], now)).toBe(2);
      expect(await readResourceEvidenceFile(runsDir)).toBeNull();
      expect(await cmdResourcesEvidence([...args, '--expires', '2026-12-01T22:31:00Z,2026-12-12T22:26:00Z'], now)).toBe(0);
      const recorded = JSON.parse(log.mock.lastCall![0]);
      expect(recorded).toMatchObject({ count: 2, grants: [{ source: 'owner-screenshot' }, { source: 'owner-screenshot' }] });
      await configure({ 'codex-personal-resets': 'Usage limit resets' });
      now += 11 * 60_000;
      text['codex-personal-resets'] = 'AXHeading Usage limit resets\nAXStaticText Available: 2\nAXStaticText Full reset expires Dec 1, 5:31 PM EST';
      expect(await collect()).toMatchObject({ checked: ['codex-personal-resets'], nextAt: now + 5 * 60_000 });
      expect(await readResourceEvidenceFile(runsDir)).toMatchObject({ readings: { 'codex-personal-resets': recorded } });
      now += 5 * 60_000;
      text['codex-personal-resets'] += '\nAXStaticText Weekly reset expires Dec 12, 5:26 PM EST\nAXHeading Credits\nAXStaticText Available: 0';
      expect(await collect()).toMatchObject({ checked: ['codex-personal-resets'] });
      expect(await readResourceEvidenceFile(runsDir)).toMatchObject({ readings: { 'codex-personal-resets': {
        count: 2, grants: [
          { count: 1, kind: 'full', expires_at: '2026-12-01T22:31:00.000Z', source: 'chatgpt-settings-usage' },
          { count: 1, kind: 'weekly', expires_at: '2026-12-12T22:26:00.000Z', source: 'chatgpt-settings-usage' },
        ],
      } } });
    } finally { log.mockRestore(); error.mockRestore(); }
  });

  it('collects all six target types through bounded reads and feeds existing resource-live sources', async () => {
    await configure({
      antigravity: 'Google AI Ultra Gemini 5-hour usage', dot: 'Dot quota', cursor: 'Cursor included usage',
      'grok-bot': 'Grok Bot quota', 'claude-api': 'Claude promotional credit', 'openai-api': 'OpenAI promotional credit',
    });
    text = {
      antigravity: 'AXWindow antigravity\nAXHeading Google AI Ultra Gemini 5-hour usage\nAXStaticText 80% remaining\nAXStaticText Resets at: 2026-12-01T17:00:00Z',
      dot: 'Dot quota\nUsed: 24%',
      cursor: 'Cursor included usage\nUsed: 30%',
      'grok-bot': 'Grok Bot quota\nUsed: 0%',
      'claude-api': 'Claude promotional credit\nGrant total: $200\nRemaining: $150.05\nExpires at: 2026-12-02T00:00:00Z',
      'openai-api': 'OpenAI promotional credit\nGrant total: $200\nUsed: $43\nExpires at: 2026-12-02T00:00:00Z\nUnrelated raw screen text',
    };
    expect((await collect()).checked).toEqual(['antigravity', 'dot', 'cursor', 'grok-bot', 'claude-api', 'openai-api']);
    expect(operator.mock.calls.map(([req]) => req.verb)).toEqual(Array.from({ length: 6 }, () => ['windows', 'read']).flat());
    expect(operator).toHaveBeenCalledWith({ verb: 'read', app: 'Quota Viewer', window: 'openai-api' });
    const file = join(runsDir, 'state', 'resource-evidence.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).not.toContain('raw screen text');
    expect(await readResourceEvidenceFile(runsDir)).toMatchObject({
      schema: 'resource-evidence.v1', readings: {
        antigravity: { window_start: '2026-12-01T12:00:00.000Z', observed_at: '2026-12-01T12:03:00.000Z', used: 20, limit: 100 },
        dot: { used: 24 }, cursor: { used: 30 }, 'grok-bot': { used: 0 },
        'claude-api': { used: 49.95, limit: 200 }, 'openai-api': { used: 43, expires_at: '2026-12-02T00:00:00.000Z' },
      },
    });
    const sources = defaultResourceLiveSources({ runsDir });
    expect(await antigravityAgentCheck(runsDir).read(now)).toMatchObject({ used: 20, unit: 'percent' });
    expect(await sources['openai-api']![0]!.read(now)).toMatchObject({ used: 43, unit: 'usd' });
  });

  it('checks before and at each observed boundary, retries unknowns, and keeps other rows', async () => {
    await configure({ 'openai-api': 'OpenAI promotional credit', antigravity: 'Google AI Ultra 5-hour usage' });
    text = {
      antigravity: 'Google AI Ultra 5-hour usage\nUsed: 50%\nResets at: 2026-12-01T12:07:00Z',
      'openai-api': 'OpenAI promotional credit\nGrant total: $200\nUsed: $20\nExpires at: 2026-12-01T12:08:00Z',
    };
    const pass = await collect();
    expect(pass.nextAt).toBe(at + 120_000);
    now = at + 119_000;
    expect((await collect()).checked).toEqual([]);
    now = at + 120_000;
    expect((await collect()).checked).toEqual(['antigravity']);
    now = at + 180_000;
    expect((await collect()).checked).toEqual(['openai-api']);
    now = at + 240_000;
    text.antigravity = 'Google AI Ultra 5-hour usage\nUsed: 3%\nResets at: 2026-12-01T17:07:00Z';
    expect((await collect()).checked).toEqual(['antigravity']);
    now = at + 300_000;
    expect(await collect()).toEqual({ checked: ['openai-api'], nextAt: at + 600_000 });
    expect(await readResourceEvidenceFile(runsDir)).toMatchObject({ readings: {
      antigravity: { used: 3, reset_at: '2026-12-01T17:07:00.000Z' },
      'openai-api': { used: null, limit: null, reset_at: null },
    } });
    await configure({ dot: 'Dot quota' });
    expect((await collect()).checked).toEqual(['dot']);
    expect(operator.mock.calls.filter(([req]) => req.verb === 'read' && req.window === 'dot')).toHaveLength(0);
    expect(await readResourceEvidenceFile(runsDir)).toMatchObject({ readings: { antigravity: { used: 3 }, dot: { used: null, limit: null } } });
  });

  it('rejects ambiguous usage, a weekly reset and an aggregate credit balance', async () => {
    await configure({ cursor: 'Included usage', antigravity: 'Gemini weekly usage', 'claude-api': 'Total credits' });
    text = {
      antigravity: 'Gemini weekly usage\nUsed: 25%\nResets at: 2026-12-01T17:00:00Z',
      cursor: 'Included usage\nUsed: 30%\nUsed: 50%',
      'claude-api': 'Total credits\nGrant total: $200\nUsed: $20\nExpires at: 2026-12-02T00:00:00Z',
    };
    await collect();
    expect(await readResourceEvidenceFile(runsDir)).toMatchObject({ readings: {
      antigravity: { used: null, limit: null },
      cursor: { used: null, limit: null },
      'claude-api': { used: null, limit: null },
    } });
  });
});
