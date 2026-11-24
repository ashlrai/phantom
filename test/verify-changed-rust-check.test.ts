import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rustPreflight, runRustSyntaxCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles rust coverage', () => {
  it('selects existing .rs files and skips deleted or non-rust paths', () => {
    const selection = selectChangedFiles(
      ['desktop/src-tauri/src/lib.rs', 'desktop/src-tauri/build.rs', 'src/core/x.ts', 'gone.rs', 'Cargo.toml'],
      ['desktop/src-tauri/src/lib.rs', 'desktop/src-tauri/build.rs', 'src/core/x.ts', 'Cargo.toml'],
    );
    expect(selection.rustFiles).toEqual(['desktop/src-tauri/build.rs', 'desktop/src-tauri/src/lib.rs']);
  });
});

describe('rustPreflight', () => {
  it('is ok when rustfmt --version exits 0', () => {
    const spawn = () => ({ status: 0, stdout: 'rustfmt 1.8.0-stable', stderr: '', error: undefined, signal: null });
    expect(rustPreflight(spawn as never).ok).toBe(true);
  });

  it('fails closed when rustfmt errors, is killed, or exits non-zero', () => {
    for (const result of [
      { status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null },
      { status: null, stdout: '', stderr: '', error: undefined, signal: 'SIGTERM' },
      { status: 1, stdout: '', stderr: 'no toolchain', error: undefined, signal: null },
    ]) {
      const spawn = () => result;
      const preflight = rustPreflight(spawn as never);
      expect(preflight.ok).toBe(false);
      expect(preflight).toHaveProperty('reason');
    }
  });
});

describe('runRustSyntaxCheck', () => {
  it('parses each changed file through rustfmt --emit stdout without writing', () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runRustSyntaxCheck('/repo', ['a.rs', 'dir/b.rs'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe('rustfmt');
    expect(calls[0]!.args).toEqual(['--edition', '2021', '--config', 'skip_children=true', '--emit', 'stdout', 'a.rs']);
    expect(calls[1]!.args.at(-1)).toBe('dir/b.rs');
    expect(calls[0]!.opts.cwd).toBe('/repo');
    // stdout is discarded so the formatted text can never overflow a buffer.
    expect(calls[0]!.opts.stdio).toEqual(['ignore', 'ignore', 'pipe']);
  });

  it('returns false and names the file on a non-zero rustfmt result', () => {
    const spawn = () => ({ status: 1, stdout: '', stderr: 'error: expected item after attributes', error: undefined, signal: null });
    expect(runRustSyntaxCheck('/repo', ['bad.rs'], spawn as never)).toBe(false);
  });

  it('returns false when rustfmt cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runRustSyntaxCheck('/repo', ['a.rs'], spawn as never)).toBe(false);
  });

  it('parses a real valid file and rejects a real syntax error when rustfmt exists', () => {
    if (!rustPreflight().ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-rust-'));
    try {
      writeFileSync(join(root, 'ok.rs'), 'fn main() {\n    let x = 1;\n}\n');
      writeFileSync(join(root, 'bad.rs'), 'fn broken(:\n');
      expect(runRustSyntaxCheck(root, ['ok.rs'])).toBe(true);
      expect(runRustSyntaxCheck(root, ['bad.rs'])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
