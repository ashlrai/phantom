import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
const runner = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: runner }));
import { approvedTeammateHandle, sendApprovedTeammateMessage, reconcileTeammateMessage } from '../src/core/comms/imessage-teammate-transport.js';
import { senderIdFor } from '../src/core/comms/imessage-teammate-inbox.js';

let configDir: string;
const agent = 'agent@example.test';
const sender = senderIdFor(agent);
const cfg = { comms: { enabled: true, imessageHandle: 'owner@example.test', imessageAllow: ['owner@example.test', agent] } } as AshlrConfig;
let platform: PropertyDescriptor;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'imessage-transport-'));
  writeFileSync(join(configDir, 'agent-network.toml'), `[team]\nidentities = [{ channel = "imessage", id = "${sender}" }]\n`, { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = true\n', { mode: 0o600 });
  platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  runner.mockReset(); runner.mockImplementation((_file, _args, _options, cb) => cb(null, '', ''));
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); rmSync(configDir, { recursive: true, force: true }); });
describe('approved teammate transport', () => {
  it('requires three independent facts: inbound allowlist, exact team identity and human communication confirmation', () => {
    expect(approvedTeammateHandle(sender, cfg, { configDir })).toBe(agent);
    expect(approvedTeammateHandle(senderIdFor('owner@example.test'), cfg, { configDir })).toBeNull();
    expect(approvedTeammateHandle(sender, { comms: { ...cfg.comms, imessageAllow: ['owner@example.test'] } } as AshlrConfig, { configDir })).toBeNull();
    writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = false\n');
    expect(approvedTeammateHandle(sender, cfg, { configDir })).toBeNull();
    writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = true\n');
    writeFileSync(join(configDir, 'agent-network.toml'), '[team]\nidentities = []\n');
    expect(approvedTeammateHandle(sender, cfg, { configDir })).toBeNull();
  });
  it('passes native text as argv, never executable AppleScript or shell interpolation', async () => {
    const text = 'A "quote" \\ and newline\n$(unsafe)';
    expect(await sendApprovedTeammateMessage(text, sender, cfg, { configDir })).toBe('accepted');
    expect(runner.mock.calls[0]?.[0]).toBe('/usr/bin/osascript');
    const args = runner.mock.calls[0]?.[1] as string[];
    expect(args[1]).not.toContain(text); expect(args.slice(2)).toEqual([agent, text]);
  });
  it('never sends for missing policy and treats native errors as uncertain', async () => {
    expect(await sendApprovedTeammateMessage('reply', 'imessage:0000000000000000', cfg, { configDir })).toBe('refused');
    expect(runner).not.toHaveBeenCalled();
    runner.mockImplementation((_file, _args, _options, cb) => cb(new Error('timeout'), '', ''));
    expect(await sendApprovedTeammateMessage('reply', sender, cfg, { configDir })).toBe('uncertain');
  });
  it('reconciles text and attributed-body records for the exact recipient and send window', async () => {
    runner.mockImplementation((_file, _args, _options, cb) => cb(null, '[{"rowid":99,"sent":1,"delivered":1,"error":0}]', ''));
    expect(await reconcileTeammateMessage("owner's reply", sender, 1793933400000, cfg, { configDir })).toEqual({ rowid: 99, sent: true, delivered: true, error: 0 });
    const args = runner.mock.calls[0]?.[1] as string[];
    expect(args).toContain('-readonly'); expect(args[args.length - 1]).toContain("m.text='owner''s reply'");
    expect(args[args.length - 1]).toContain('instr(hex(m.attributedBody)');
    expect(args[args.length - 1]).toContain("lower(h.id)=lower('agent@example.test')");
  });
});
