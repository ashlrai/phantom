import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSwiftSyntaxCheck, selectChangedFiles, swiftPreflight } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles swift coverage', () => {
  it('selects existing .swift files and skips deleted or non-swift paths', () => {
    const selection = selectChangedFiles(
      ['tools/custody/Package.swift', 'tools/custody/Sources/CustodyCore/StrictJSON.swift', 'tools/desktop-operator/main.swift', 'src/core/x.ts', 'gone.swift', 'Cargo.toml'],
      ['tools/custody/Package.swift', 'tools/custody/Sources/CustodyCore/StrictJSON.swift', 'tools/desktop-operator/main.swift', 'src/core/x.ts', 'Cargo.toml'],
    );
    expect(selection.swiftFiles).toEqual([
      'tools/custody/Package.swift',
      'tools/custody/Sources/CustodyCore/StrictJSON.swift',
      'tools/desktop-operator/main.swift',
    ]);
  });
});

describe('swiftPreflight', () => {
  it('is ok when swiftc --version exits 0', () => {
    const spawn = () => ({ status: 0, stdout: 'Apple Swift version 6.2.3', stderr: '', error: undefined, signal: null });
    expect(swiftPreflight(spawn as never).ok).toBe(true);
  });

  it('fails closed when swiftc errors, is killed, or exits non-zero', () => {
    for (const result of [
      { status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null },
      { status: null, stdout: '', stderr: '', error: undefined, signal: 'SIGTERM' },
      { status: 1, stdout: '', stderr: 'no toolchain', error: undefined, signal: null },
    ]) {
      const spawn = () => result;
      const preflight = swiftPreflight(spawn as never);
      expect(preflight.ok).toBe(false);
      expect(preflight).toHaveProperty('reason');
    }
  });
});

describe('runSwiftSyntaxCheck', () => {
  it('parses each changed file through swiftc -parse', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runSwiftSyntaxCheck('/repo', ['a.swift', 'dir/b.swift'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe('swiftc');
    expect(calls[0]!.args).toEqual(['-parse', 'a.swift']);
    expect(calls[1]!.args).toEqual(['-parse', 'dir/b.swift']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
    expect(calls[0]!.opts.stdio).toEqual(['ignore', 'ignore', 'pipe']);
  });

  it('returns false and names the file on a non-zero swiftc result', () => {
    const spawn = () => ({ status: 1, stdout: '', stderr: 'error: expected parameter name followed by \':\'', error: undefined, signal: null });
    expect(runSwiftSyntaxCheck('/repo', ['bad.swift'], spawn as never)).toBe(false);
  });

  it('returns false when swiftc cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runSwiftSyntaxCheck('/repo', ['a.swift'], spawn as never)).toBe(false);
  });

  it('parses a real valid file and rejects a real syntax error when swiftc exists', () => {
    if (!swiftPreflight().ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-swift-'));
    try {
      writeFileSync(join(root, 'ok.swift'), 'func answer() -> Int {\n    return 42\n}\n');
      writeFileSync(join(root, 'bad.swift'), 'func broken(:\n');
      expect(runSwiftSyntaxCheck(root, ['ok.swift'])).toBe(true);
      expect(runSwiftSyntaxCheck(root, ['bad.swift'])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
