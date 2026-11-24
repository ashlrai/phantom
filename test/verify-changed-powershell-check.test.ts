import { describe, expect, it } from 'vitest';
import { powershellPreflight, runPowerShellSyntaxCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles powershell coverage', () => {
  it('selects existing .ps1/.psm1/.psd1 files and skips deleted or non-powershell paths', () => {
    const selection = selectChangedFiles(
      ['scripts/install.ps1', 'tools/mod.PSM1', 'tools/data.psd1', 'src/core/x.ts', 'gone.ps1', 'README.md', 'notes.ps1x'],
      ['scripts/install.ps1', 'tools/mod.PSM1', 'tools/data.psd1', 'src/core/x.ts', 'README.md', 'notes.ps1x'],
    );
    expect(selection.powershellFiles).toEqual(['scripts/install.ps1', 'tools/data.psd1', 'tools/mod.PSM1']);
  });
});

describe('powershellPreflight', () => {
  it('returns the first host that answers the probe', () => {
    const tried: string[] = [];
    const spawn = (cmd: string) => {
      tried.push(cmd);
      return cmd === 'pwsh'
        ? { status: 0, stdout: '', stderr: '', error: undefined, signal: null }
        : { status: 1, stdout: '', stderr: '', error: undefined, signal: null };
    };
    const preflight = powershellPreflight(spawn as never);
    expect(preflight).toEqual({ ok: true, exe: 'pwsh' });
    expect(tried).toEqual(['pwsh']);
  });

  it('falls back to powershell when pwsh is absent', () => {
    const tried: string[] = [];
    const spawn = (cmd: string) => {
      tried.push(cmd);
      return cmd === 'pwsh'
        ? { status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null }
        : { status: 0, stdout: '', stderr: '', error: undefined, signal: null };
    };
    const preflight = powershellPreflight(spawn as never);
    expect(preflight).toEqual({ ok: true, exe: 'powershell' });
    expect(tried).toEqual(['pwsh', 'powershell']);
  });

  it('fails closed when neither host runs', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    const preflight = powershellPreflight(spawn as never);
    expect(preflight.ok).toBe(false);
    expect(preflight).toHaveProperty('reason');
  });

  it('rejects a host that is killed or exits non-zero on both names', () => {
    for (const result of [
      { status: null, stdout: '', stderr: '', error: undefined, signal: 'SIGTERM' },
      { status: 1, stdout: '', stderr: 'no powershell', error: undefined, signal: null },
    ]) {
      const spawn = () => result;
      const preflight = powershellPreflight(spawn as never);
      expect(preflight.ok).toBe(false);
    }
  });
});

describe('runPowerShellSyntaxCheck', () => {
  it('spawns the probed host once per file with the path in the environment', () => {
    const calls: { cmd: string; args: string[]; opts: { cwd: string; env: Record<string, string> } }[] = [];
    const spawn = (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runPowerShellSyntaxCheck('/repo', ['a.ps1', 'dir/b.psm1'], 'pwsh', spawn as never)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe('pwsh');
    expect(calls[0]!.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(calls[0]!.args[3]).toContain('ParseFile');
    expect(calls[0]!.opts.cwd).toBe('/repo');
    expect(calls[0]!.opts.env['PHANTOM_VERIFY_PS1_FILE']).toBe('/repo/a.ps1');
    expect(calls[1]!.opts.env['PHANTOM_VERIFY_PS1_FILE']).toBe('/repo/dir/b.psm1');
  });

  it('honors the powershell.exe fallback name', () => {
    const cmds: string[] = [];
    const spawn = (cmd: string) => {
      cmds.push(cmd);
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runPowerShellSyntaxCheck('/repo', ['a.ps1'], 'powershell', spawn as never)).toBe(true);
    expect(cmds).toEqual(['powershell']);
  });

  it('returns false on the first non-zero result and names the file', () => {
    const calls: string[] = [];
    const spawn = (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
      calls.push(opts.env['PHANTOM_VERIFY_PS1_FILE']!);
      return { status: calls.length === 1 ? 0 : 1, stdout: '', stderr: 'ParseError', error: undefined, signal: null };
    };
    expect(runPowerShellSyntaxCheck('/repo', ['/repo/good.ps1', '/repo/bad.ps1', '/repo/never.ps1'], 'pwsh', spawn as never)).toBe(false);
    expect(calls).toEqual(['/repo/good.ps1', '/repo/bad.ps1']);
  });

  it('returns false when the interpreter cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runPowerShellSyntaxCheck('/repo', ['a.ps1'], 'pwsh', spawn as never)).toBe(false);
  });
});
