import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DROP_JOB_ID, DROP_JOB_LANES, DROP_JOB_TIERS, DROP_JOB_MAX_FILE_BYTES } from '../../../../core/fleet/drop-job-writer.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { buildJobBody, DENIED_TOKENS, jobIdFor, parseJobCommand, runJobCommand } from './job-drop-command.js';

beforeEach(() => setMutationToken('fake-job-token'));
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('parses defaults, multiline text and option overrides', () => {
  expect(parseJobCommand('/job hello\nworld ')).toEqual({ lane: 'codex-personal', tier: 'mid', text: 'hello\nworld' });
  for (const lane of DROP_JOB_LANES) for (const tier of DROP_JOB_TIERS) {
    expect(parseJobCommand(`/job tier=${tier} lane=${lane} fix X`)).toEqual({ lane, tier, text: 'fix X' });
  }
  expect(parseJobCommand('/jobs hello')).toBeNull();
  expect(parseJobCommand('hello /job world')).toBeNull();
  expect(parseJobCommand('/job explain lane=devin')).toHaveProperty('text', 'explain lane=devin');
});

it('refuses empty text, unknown options and more than 6000 UTF-8 bytes', () => {
  for (const draft of ['/job', '/job  ', '/job lane=devin tier=work']) expect(parseJobCommand(draft)).toEqual({ error: 'Use /job [lane=…] [tier=…] <what to build>' });
  expect(parseJobCommand('/job lane=unknown hello')).toEqual({ error: `Unknown lane; allowed values: ${DROP_JOB_LANES.join(', ')}` });
  expect(parseJobCommand('/job tier=unknown hello')).toEqual({ error: `Unknown tier; allowed values: ${DROP_JOB_TIERS.join(', ')}` });
  expect(parseJobCommand(`/job ${'é'.repeat(3000)}`)).toHaveProperty('text');
  expect(parseJobCommand(`/job ${'é'.repeat(3001)}`)).toHaveProperty('error');
});

it('mirrors the private core denylist and refuses each token', () => {
  const core = readFileSync(new NodeURL('../../../../core/fleet/drop-job-writer.ts', import.meta.url), 'utf8');
  const tokens = [...core.match(/const DENIED_TOKENS = \[([^\]]+)\]/)![1]!.matchAll(/'([^']+)'/g)].map(match => match[1]);
  expect(DENIED_TOKENS).toEqual(tokens);
  for (const token of DENIED_TOKENS) expect(parseJobCommand(`/job edit ${token} please`)).toEqual({ error: 'the fleet ingest rejects that path' });
});

it('builds deterministic valid ids and a bounded body with worker instructions', () => {
  const at = '2026-11-01T04:08:00.000Z';
  expect(jobIdFor('say hello in', 123)).toBe('MASONSAYHELLOIN3F');
  for (const text of ['hello world', '你好', 'x'.repeat(6000), '123 ! punctuation']) expect(jobIdFor(text, Date.parse(at))).toMatch(DROP_JOB_ID);
  const body = buildJobBody('fix X', at);
  expect(body).toContain(`Goal (Mason, Phantom desktop composer, ${at}): fix X`);
  expect(body).toContain('Leave changes uncommitted');
  expect(body).toContain('BRIDGE_NOTES.md');
  expect(body).toContain('at least one new test file');
  expect(new TextEncoder().encode(`#job repo=phantom lane=codex-personal tier=frontier\n${buildJobBody('x'.repeat(6000), at)}`).length).toBeLessThan(DROP_JOB_MAX_FILE_BYTES);
});

it('posts the expected envelope once with the mutation token and confirms server bytes', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1234567890000);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ status: 'written', bytes: 321 }, { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  expect(await runJobCommand('/job lane=devin tier=work fix X')).toEqual({ ok: true, text: `Dropped job RQ-PHX-${jobIdFor('fix X', Date.now())} for devin/work · 321 bytes` });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/verse/fleet/live/drop-jobs');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual({ id: jobIdFor('fix X', Date.now()), lane: 'devin', tier: 'work', body: buildJobBody('fix X', new Date(Date.now()).toISOString()) });
  expect(JSON.stringify(init.headers)).toContain('fake-job-token');
});

it.each([
  [404, 'Drop-jobs API is not in this build'],
  [409, 'That job id already exists'],
  [503, 'Prompt queue is full (40); wait for ingest'],
  [507, 'Prompt queue is full (40); wait for ingest'],
  [400, 'The server answered HTTP 400.'],
  [500, 'The server answered HTTP 500.'],
])('maps HTTP %i', async (status, text) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status })));
  expect(await runJobCommand('/job hello')).toEqual({ ok: false, text });
});

it('does not post locked or malformed commands', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  clearMutationToken();
  expect(await runJobCommand('/job hello')).toEqual({ ok: false, text: 'Unlock actions with the mutation token before chatting.' });
  expect(await runJobCommand('/job')).toHaveProperty('ok', false);
  expect(await runJobCommand('/bus hello')).toHaveProperty('ok', false);
  expect(fetcher).not.toHaveBeenCalled();
});
