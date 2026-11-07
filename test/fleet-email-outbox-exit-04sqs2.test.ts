import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetEmailOutbox } from '../src/cli/fleet-email-outbox.js';
import { writeEmailDropConfig } from '../src/core/comms/email-drop-config.js';
import type { EmailTransport } from '../src/core/comms/email-outbox.js';

const recipient = 'operator@example.test';
const body = 'private fixture body';
let root: string;
let runsDir: string;
let outboxDir: string;
let output: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'outbox-exit-'));
  runsDir = join(root, 'runs');
  outboxDir = join(root, 'outbox');
  mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
  await writeEmailDropConfig(runsDir, { v: 1, inboxDir: join(root, 'inbox'), outboxDir, from: [recipient] });
  output = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function reply(name: string, to = recipient, dir = outboxDir): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${name}.reply.eml`), `To: ${to}\r\nSubject: Test\r\n\r\n${body}\r\n`, { mode: 0o600 });
}

async function run(transport: EmailTransport, send = true): Promise<{ code: number; result: Record<string, unknown> }> {
  const code = await cmdFleetEmailOutbox(send ? ['--send', '--json'] : ['--json'], { runsDir, transport, policyCheck: () => ({ decision: 'allow', reason: 'test-allow' }) });
  expect(output.join('\n')).not.toContain(body);
  return { code, result: JSON.parse(output[0]!) as Record<string, unknown> };
}

const success: EmailTransport = async () => ({ ok: true });

describe('fleet email-outbox exit status', () => {
  it('succeeds on delivery', async () => {
    reply('one');
    const { code, result } = await run(success);
    expect(code).toBe(0);
    expect(result).toMatchObject({ queued: 0, sent: 1, drafted: 0, refused: 0, failed: 0, stuck: 0 });
  });

  it('fails on a nonthrowing transport failure', async () => {
    reply('one');
    const { code, result } = await run(async () => ({ ok: false, error: 'unavailable' }));
    expect(code).toBe(1);
    expect(result).toMatchObject({ sent: 0, refused: 0, failed: 1, stuck: 0 });
  });

  it('fails when delivery results are mixed', async () => {
    reply('a'); reply('b');
    let calls = 0;
    const { code, result } = await run(async () => ({ ok: ++calls === 1 }));
    expect(code).toBe(1);
    expect(result).toMatchObject({ sent: 1, failed: 1, refused: 0, stuck: 0 });
  });

  it('fails for an interrupted claim without resending', async () => {
    reply('orphan', recipient, join(outboxDir, 'sending'));
    const transport = vi.fn(success);
    const { code, result } = await run(transport);
    expect(code).toBe(1);
    expect(result).toMatchObject({ sent: 0, failed: 0, refused: 0, stuck: 1, details: [{ outcome: 'stuck', reason: 'interrupted-send' }] });
    expect(transport).not.toHaveBeenCalled();
  });

  it('fails for an explicitly refused recipient', async () => {
    reply('multiple', 'one@example.test, two@example.test');
    const transport = vi.fn(success);
    const { code, result } = await run(transport);
    expect(code).not.toBe(0);
    expect(result).toMatchObject({ sent: 0, failed: 0, refused: 1, stuck: 0, details: [{ outcome: 'refused', reason: 'multiple-recipients' }] });
    expect(transport).not.toHaveBeenCalled();
  });

  it('treats conversion to a draft as successful processing', async () => {
    reply('draft', 'other@example.test');
    const transport = vi.fn(success);
    const { code, result } = await run(transport);
    expect(code).toBe(0);
    expect(result).toMatchObject({ sent: 0, drafted: 1, refused: 0, failed: 0, stuck: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('succeeds on an empty outbox', async () => {
    const { code, result } = await run(success);
    expect(code).toBe(0);
    expect(result).toMatchObject({ queued: 0, sent: 0, drafted: 0, refused: 0, failed: 0, stuck: 0 });
  });

  it('lists without sending, even with a stuck claim', async () => {
    reply('one'); reply('orphan', recipient, join(outboxDir, 'sending'));
    const transport = vi.fn(success);
    const { code, result } = await run(transport, false);
    expect(code).toBe(0);
    expect(result.counts).toMatchObject({ queued: 1, sent: 0, stuck: 1 });
    expect(transport).not.toHaveBeenCalled();
  });
});
