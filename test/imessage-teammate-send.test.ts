import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn((_file, _args, _opts, cb) => cb(null, '', '')) }));
vi.mock('node:child_process', () => ({ execFile }));
import { sendIMessageOutbox } from '../src/core/comms/imessage-outbox.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let home: string;
let registry: string;
let owner: string;
let agent: string;
let stranger: string;
let cfg: AshlrConfig;
const handle = () => `${randomUUID()}@example.invalid`;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'imessage-teammate-send-'));
  vi.stubEnv('HOME', home);
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  registry = join(home, '.phantom', 'agents', 'teammates.json');
  mkdirSync(join(home, '.phantom', 'agents'), { recursive: true });
  owner = handle(); agent = handle(); stranger = handle();
  cfg = { comms: { enabled: true, imessageHandle: owner, imessageAllow: [stranger] } } as AshlrConfig;
});
afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', platform);
  execFile.mockClear();
  rmSync(home, { recursive: true, force: true });
});

describe('agent teammate iMessage outbox', () => {
  it('sends once to a registered agent using its handle and preserves owner config', async () => {
    writeFileSync(registry, JSON.stringify([{ kind: 'agent', handle: agent }]));
    expect(await sendIMessageOutbox('reply', cfg, ` ${agent.toUpperCase()} `)).toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1][1]).toContain(`to participant "${agent.toUpperCase()}"`);
    expect(cfg.comms?.imessageHandle).toBe(owner);
  });
  it('keeps strangers and human teammates on the existing draft path', async () => {
    writeFileSync(registry, JSON.stringify([{ kind: 'agent', handle: agent }, { kind: 'human', handle: stranger }]));
    for (const to of [stranger, handle(), `${agent}extra`, '']) {
      expect(await sendIMessageOutbox('reply', cfg, to)).toEqual({ ok: false, reason: 'drafts_unavailable' });
    }
    expect(execFile).not.toHaveBeenCalled();
  });
  it('sends only to self when the registry is missing', async () => {
    expect(await sendIMessageOutbox('reply', cfg, agent)).toEqual({ ok: false, reason: 'drafts_unavailable' });
    expect(await sendIMessageOutbox('reply', cfg, owner)).toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledTimes(1);
  });
  it.each(['{', '{}', 'null', '[null, {}, {"kind":"agent","handle":7}]'])('fails closed for malformed registry %s', async (data) => {
    writeFileSync(registry, data);
    expect(await sendIMessageOutbox('reply', cfg, agent)).toEqual({ ok: false, reason: 'drafts_unavailable' });
    expect(execFile).not.toHaveBeenCalled();
  });
  it('refuses a registry that is a symlink or oversized', async () => {
    const target = join(home, 'elsewhere.json');
    writeFileSync(target, JSON.stringify([{ kind: 'agent', handle: agent }]));
    symlinkSync(target, registry);
    expect(await sendIMessageOutbox('reply', cfg, agent)).toEqual({ ok: false, reason: 'drafts_unavailable' });
    rmSync(registry);
    // Valid matching entry padded past the cap: the size bound is what refuses it.
    writeFileSync(registry, `[{"kind":"agent","handle":"${agent}"},"${'x'.repeat(64 * 1024)}"]`);
    expect(await sendIMessageOutbox('reply', cfg, agent)).toEqual({ ok: false, reason: 'drafts_unavailable' });
    expect(execFile).not.toHaveBeenCalled();
  });
  it('keeps disabled and unconfigured channels disabled for agents', async () => {
    writeFileSync(registry, JSON.stringify([{ kind: 'agent', handle: agent }]));
    cfg.comms!.enabled = false;
    expect(await sendIMessageOutbox('reply', cfg, agent)).toEqual({ ok: false });
    cfg.comms!.enabled = true;
    cfg.comms!.imessageHandle = '';
    expect(await sendIMessageOutbox('reply', cfg, agent)).toEqual({ ok: false });
    expect(execFile).not.toHaveBeenCalled();
  });
});
