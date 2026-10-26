import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import {
  knowledgeDir, loadChunks, MAX_AGENT_MEMORY_BYTES, readAgentMemory, writeAgentMemory,
} from '../src/core/knowledge/index.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(tmpdir(), 'knowledge-memory-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});
function memoryFile(): string {
  const dir = path.join(knowledgeDir(), 'agents');
  return path.join(dir, fs.readdirSync(dir)[0]!);
}

describe('per-agent chat memory', () => {
  it('missing reads create no directories and require no enrollment or network', () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    expect(homedir()).toBe(home);
    expect(readAgentMemory('agent:alpha')).toBeNull();
    expect(fs.readdirSync(home)).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it('persists exact text, replaces it, and isolates case-sensitive agent identities', () => {
    const text = 'Prefer concise replies.\nUse 日本語 when asked.\n';
    const saved = writeAgentMemory('agent:alpha', text);
    expect(saved).toEqual({ agentId: 'agent:alpha', text, updatedAt: expect.any(String) });
    expect(new Date(saved.updatedAt).toISOString()).toBe(saved.updatedAt);
    expect(readAgentMemory('agent:alpha')).toEqual(saved);
    expect(readAgentMemory('agent:Alpha')).toBeNull();
    writeAgentMemory('agent:Alpha', 'Another agent');
    writeAgentMemory('agent:alpha', 'Updated preference');
    expect(readAgentMemory('agent:alpha')?.text).toBe('Updated preference');
    expect(readAgentMemory('agent:Alpha')?.text).toBe('Another agent');
    expect(loadChunks()).toEqual([]);
    writeAgentMemory('agent:alpha', '');
    expect(readAgentMemory('agent:alpha')?.text).toBe('');
  });

  it('accepts Phantom Secrets references', () => {
    const text = 'Use phm_project_service for credentials through Phantom Secrets.';
    expect(writeAgentMemory('alpha', text).text).toBe(text);
  });

  it.each(['', '../escape', '/absolute', '.', 'a/b', 'a\\b', 'a\n', 'a'.repeat(129)])(
    'rejects invalid identity %j before I/O', (id) => {
      expect(() => writeAgentMemory(id, 'safe')).toThrow('Invalid agent memory identity');
      expect(() => readAgentMemory(id)).toThrow('Invalid agent memory identity');
      expect(fs.readdirSync(home)).toEqual([]);
    },
  );

  // Synthetic shapes only. Test labels and failure messages contain no credential values.
  const secretShapes = [
    'api_key=' + 'Z9'.repeat(16),
    JSON.stringify({ password: 'synthetic-password' }),
    'DB_PASSWORD=synthetic-password',
    'ghp_' + 'a'.repeat(36),
    'sk_live_' + 'a'.repeat(24),
    'AKIA' + 'A'.repeat(16),
    'eyJabc.eyJdef.signature',
    'ab'.repeat(16),
    '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----',
    'https://user:synthetic-password@example.com',
  ];
  it.each(secretShapes.map((text, index) => ({ text, index })))(
    'rejects secret pattern $index without altering existing memory', ({ text }) => {
      const before = writeAgentMemory('alpha', 'Safe preference');
      const bytes = fs.readFileSync(memoryFile());
      expect(() => writeAgentMemory('alpha', text)).toThrow('contains a secret pattern');
      expect(fs.readFileSync(memoryFile())).toEqual(bytes);
      expect(readAgentMemory('alpha')).toEqual(before);
    },
  );

  it('rejects unsafe initial writes without creating storage', () => {
    expect(() => writeAgentMemory('alpha', secretShapes[0]!)).toThrow();
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('rejects secret-shaped agent identities before persisting metadata', () => {
    const id = 'ghp_' + 'a'.repeat(36);
    expect(() => writeAgentMemory(id, 'Safe')).toThrow('Invalid agent memory identity');
    expect(() => readAgentMemory(id)).toThrow('Invalid agent memory identity');
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('rejects non-string input from untyped API callers', () => {
    expect(() => writeAgentMemory('alpha', null as unknown as string)).toThrow('must be text');
    expect(() => writeAgentMemory(null as unknown as string, 'Safe')).toThrow('Invalid agent memory identity');
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('bounds UTF-8 bytes and supports JSON-escaped text at the limit', () => {
    const text = '\u0001'.repeat(MAX_AGENT_MEMORY_BYTES);
    writeAgentMemory('alpha', text);
    expect(readAgentMemory('alpha')?.text).toBe(text);
    expect(() => writeAgentMemory('alpha', '界'.repeat(22000))).toThrow('UTF-8 bytes');
    expect(readAgentMemory('alpha')?.text).toBe(text);
  });

  it('uses private files and directories and leaves no temporary files', () => {
    writeAgentMemory('alpha', 'Safe');
    expect(fs.readdirSync(path.dirname(memoryFile()))).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect(fs.statSync(memoryFile()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(memoryFile())).mode & 0o777).toBe(0o700);
    }
  });

  it('handles partial filesystem reads without truncating memory', () => {
    const saved = writeAgentMemory('alpha', 'Remember this complete preference.');
    const original = fs.readSync;
    vi.spyOn(fs, 'readSync').mockImplementation(((
      fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null,
    ) => original(fd, buffer, offset, Math.min(length, 7), position)) as typeof fs.readSync);
    expect(readAgentMemory('alpha')).toEqual(saved);
  });

  it.each(['malformed', 'identity', 'version', 'timestamp', 'secret', 'oversize'])(
    'refuses %s persisted data without returning its contents', (kind) => {
      const saved = writeAgentMemory('alpha', 'Safe');
      const record = { version: 1, ...saved };
      const content = kind === 'malformed' ? '{private broken text' : kind === 'oversize'
        ? ' '.repeat(MAX_AGENT_MEMORY_BYTES * 6 + 1025)
        : JSON.stringify({ ...record,
          ...(kind === 'identity' ? { agentId: 'other' } : {}),
          ...(kind === 'version' ? { version: 2 } : {}),
          ...(kind === 'timestamp' ? { updatedAt: 'invalid' } : {}),
          ...(kind === 'secret' ? { text: secretShapes[0] } : {}),
        });
      fs.writeFileSync(memoryFile(), content);
      expect(() => readAgentMemory('alpha')).toThrow('Unable to read agent memory safely');
    },
  );

  it('rejects symlinked store directories', () => {
    const outside = path.join(home, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(knowledgeDir(), { recursive: true });
    fs.symlinkSync(outside, path.join(knowledgeDir(), 'agents'), 'junction');
    expect(() => writeAgentMemory('alpha', 'Safe')).toThrow('Unable to write agent memory safely');
    expect(() => readAgentMemory('alpha')).toThrow('Unable to read agent memory safely');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses file symlink reads and replaces the link without modifying its target', () => {
    writeAgentMemory('alpha', 'Safe');
    const file = memoryFile();
    const target = path.join(home, 'target.json');
    fs.renameSync(file, target);
    const original = fs.readFileSync(target);
    fs.symlinkSync(target, file);
    expect(() => readAgentMemory('alpha')).toThrow('Unable to read agent memory safely');
    writeAgentMemory('alpha', 'Replacement');
    expect(fs.readFileSync(target)).toEqual(original);
    expect(readAgentMemory('alpha')?.text).toBe('Replacement');
  });

  it('reports failed publication and preserves the previous document', () => {
    const saved = writeAgentMemory('alpha', 'Safe');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('private upstream detail'); });
    syncBuiltinESMExports();
    expect(() => writeAgentMemory('alpha', 'Replacement')).toThrow('Unable to write agent memory safely');
    expect(readAgentMemory('alpha')).toEqual(saved);
    expect(fs.readdirSync(path.dirname(memoryFile()))).toHaveLength(1);
  });
});
