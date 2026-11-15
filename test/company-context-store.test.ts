import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readCompanyContext, writeCompanyContext } from '../src/core/context/company-context-store.js';
import { cmdCompanyContext } from '../src/cli/company-context.js';
const directories: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'company-context-')); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe('company context store', () => {
  it('keeps concurrent process writes and deduplicates by id', async () => {
    const path = directory();
    await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<void>((done, reject) => {
      const code = `import { writeCompanyContext } from ${JSON.stringify(resolve('src/core/context/company-context-store.ts'))}; for(let n=0;n<5;n++) writeCompanyContext({section:'decisions', text:'Decision '+${index}+' '+n, source:'test', id:'row-'+${index}+'-'+n}, ${JSON.stringify(path)});`;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: 'ignore' });
      child.on('error', reject); child.on('exit', status => status === 0 ? done() : reject(new Error('Writer failed')));
    })));
    expect(readCompanyContext({ maxTokens: 16000 }, path).digest.match(/Decision/g)).toHaveLength(20);
    expect(writeCompanyContext({ section: 'decisions', text: 'Duplicate', source: 'test', id: 'row-0-0' }, path).appended).toBe(false);
  });
  it('caps Unicode digests and filters sections and expired entries', () => {
    const path = directory();
    writeCompanyContext({ section: 'people', text: '界'.repeat(100), source: 'test', expiresAt: Date.now() + 1000 }, path);
    writeCompanyContext({ section: 'clients', text: 'Current client', source: 'test' }, path);
    const result = readCompanyContext({ maxTokens: 35 }, path);
    expect(Buffer.byteLength(result.digest)).toBeLessThanOrEqual(35);
    expect(result.truncated).toBe(true);
    expect(readCompanyContext({ now: Date.now() + 2000 }, path).digest).not.toContain('界');
    expect(readCompanyContext({ section: 'people', now: Date.now() + 2000 }, path).digest).toBe('');
    expect(() => readCompanyContext({ maxTokens: NaN }, path)).toThrow('Token limit');
  });
  it('refuses keys in every supplied text field and invalid expiry', () => {
    const path = directory();
    const key = ['sk', '-', 'test', 'Ab12'.repeat(12)].join('');
    const input = { section: 'priorities' as const, text: 'Ship safely', source: 'test' };
    for (const field of ['text', 'source', 'id']) expect(() => writeCompanyContext({ ...input, [field]: key }, path)).toThrow('Context refused');
    expect(() => writeCompanyContext({ ...input, expiresAt: 1 }, path)).toThrow('Expiry');
    expect(readCompanyContext({}, path).digest).toBe('');
    expect(() => cmdCompanyContext(['write', '--section', 'people'])).toThrow('Write requires');
    expect(() => cmdCompanyContext(['read', '--section', 'unknown'])).toThrow('Choose');
  });
});
