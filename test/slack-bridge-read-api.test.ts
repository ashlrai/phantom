import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlackBridgeStatus } from '../src/core/agents/slack-status.js';

const real = await vi.importActual<typeof import('../src/core/agents/slack-status.js')>('../src/core/agents/slack-status.js');
const build = vi.fn(real.buildSlackBridgeStatus);
vi.mock('../src/core/agents/slack-status.js', async (orig) => ({ ...(await orig<typeof import('../src/core/agents/slack-status.js')>()), buildSlackBridgeStatus: (...a: Parameters<typeof real.buildSlackBridgeStatus>) => build(...a) }));
const { handleSlackBridgeRead, projectSlackBridgeStatus, SLACK_BRIDGE_READ_PATH } = await import('../src/core/web/slack-bridge-read-api.js');

const capture = () => {
  const out: { status?: number; body?: string } = {};
  const res = { writeHead(s: number) { out.status = s; return res; }, setHeader() { return res; }, end(b?: string) { out.body = b; return res; }, headersSent: false } as never;
  return { res, out };
};
const dirs: string[] = [];
afterEach(() => { build.mockImplementation(real.buildSlackBridgeStatus); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const fixture = {
  v: 1, at: '2026-11-19T12:00:00Z',
  config: { path: '/home/fake/.ashlr/agent-network.toml', state: 'ok' }, slackSection: 'ok',
  bridge: { id: 'b', teamId: 'T000FAKE', ownUserId: 'U000FAKE', ownBotId: null },
  credentials: { custody: 'phantom-secrets', botTokenRef: 'phm_fake_bot', appTokenRef: 'phm_fake_app' },
  mappings: [{ topic: 'zeta', channel: 'C000FAKE' }, { topic: 'alpha', channel: 'C000FAKE' }, { topic: 'zeta', channel: 'C000FAKE' }],
  teamIdentities: { slack: 2, total: 3 }, comms: { confirmedByMason: true },
  journal: { state: 'ok', ingested: 4, ignored: 1, lastAt: '2026-11-19T11:00:00Z' },
  ready: true, transport: { health: 'unknown', observedAt: null, probeCommand: 'x' },
} as unknown as SlackBridgeStatus;

describe('slack bridge read api', () => {
  it('path constant', () => expect(SLACK_BRIDGE_READ_PATH).toBe('/api/fleet/slack-bridge'));

  it('projects without ids, refs or paths', () => {
    const view = projectSlackBridgeStatus(fixture);
    const text = JSON.stringify(view);
    for (const s of ['T000FAKE', 'U000FAKE', 'phm_fake_bot', 'phm_fake_app', 'C000FAKE', '/home/fake']) expect(text).not.toContain(s);
    expect(view.topics).toEqual(['alpha', 'zeta']);
    expect(view).toMatchObject({ botTokenRefSet: true, appTokenRefSet: true, slackIdentities: 2, next: null, transport: 'unknown' });
  });

  it('answers 200 unreadable when the build throws', () => {
    build.mockImplementation(() => { throw new Error('boom at /secret/stack.ts:1'); });
    const { res, out } = capture();
    handleSlackBridgeRead(res);
    expect(out.status).toBe(200);
    expect(out.body).not.toMatch(/boom|stack|secret/);
    expect(JSON.parse(out.body!)).toMatchObject({ configState: 'unreadable', ready: false, next: 'run phm channels slack status --json on the host' });
  });

  it('reports missing config for an empty temp home', () => {
    const home = mkdtempSync(join(tmpdir(), 'slack-bridge-'));
    dirs.push(home);
    const { res, out } = capture();
    handleSlackBridgeRead(res, { home, runsDir: join(home, 'runs'), stateRoot: join(home, 'state'), busRoot: join(home, 'bus') });
    const view = JSON.parse(out.body!);
    expect(out.status).toBe(200);
    expect(view.configState).toBe('missing');
    expect(view.next).toContain('agent-network.toml');
  });
});
