import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMAIL_DROP_CONFIG_FILE, readEmailDropConfig, writeEmailDropConfig, type EmailDropConfig } from '../src/core/comms/email-drop-config.js';

let root: string;
let path: string;
const config = (): EmailDropConfig => ({ v: 1, inboxDir: '/tmp/drop/inbox', from: ['fleet-test@example.invalid'] });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'email-config-')); path = join(root, EMAIL_DROP_CONFIG_FILE); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('email drop configuration', () => {
  it('reads missing, writes and replaces atomically with private permissions', async () => {
    expect(await readEmailDropConfig(root)).toEqual({ state: 'missing', path });
    expect(await writeEmailDropConfig(root, config())).toBe(path);
    expect(await readEmailDropConfig(root)).toEqual({ state: 'ok', config: config(), path });
    chmodSync(path, 0o644);
    const replacement = { ...config(), outboxDir: '/tmp/drop/outbox', processedDir: '/tmp/drop/done' };
    await writeEmailDropConfig(root, replacement);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(replacement);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, 'queue'))).toEqual(['email-drop.json']);
  });

  it('rejects invalid shapes, paths and noncanonical sender lists', async () => {
    mkdirSync(join(root, 'queue'));
    const invalid: unknown[] = [null, [], {}, { ...config(), v: 2 }, { ...config(), other: true },
      { ...config(), inboxDir: 'relative' }, { ...config(), inboxDir: '/tmp/\0bad' },
      { ...config(), outboxDir: null }, { ...config(), processedDir: 'relative' },
      { ...config(), from: [] }, { ...config(), from: Array(33).fill('a@example.invalid') },
      { ...config(), from: ['A@example.invalid'] }, { ...config(), from: [' a@example.invalid'] },
      { ...config(), from: ['<a@example.invalid>'] }, { ...config(), from: ['a@@example.invalid'] }];
    for (const value of invalid) {
      writeFileSync(path, JSON.stringify(value));
      expect((await readEmailDropConfig(root)).state).toBe('invalid');
    }
    writeFileSync(path, '{');
    expect((await readEmailDropConfig(root)).state).toBe('invalid');
    await expect(writeEmailDropConfig(root, { ...config(), from: [] })).rejects.toThrow();
  });

  it('rejects oversized and non-regular sources without following symlinks', async () => {
    mkdirSync(join(root, 'queue'));
    writeFileSync(path, ' '.repeat(16 * 1024 + 1));
    expect((await readEmailDropConfig(root)).state).toBe('invalid');
    rmSync(path);
    symlinkSync(join(root, 'missing'), path);
    expect((await readEmailDropConfig(root)).state).toBe('invalid');
    rmSync(path);
    mkdirSync(path);
    expect((await readEmailDropConfig(root)).state).toBe('invalid');
  });
});
