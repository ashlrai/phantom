import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pythonPreflight, runXmlSyntaxCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles xml coverage', () => {
  it('selects existing .xml, .plist and .svg files and skips deleted or non-xml paths', () => {
    const selection = selectChangedFiles(
      ['site/sitemap.xml', 'desktop/src-tauri/Info.plist', 'docs/brand/logo.svg', 'src/core/x.ts', 'gone.xml', 'metrics/jobs.jsonl', 'README.md'],
      ['site/sitemap.xml', 'desktop/src-tauri/Info.plist', 'docs/brand/logo.svg', 'src/core/x.ts', 'metrics/jobs.jsonl', 'README.md'],
    );
    expect(selection.xmlFiles).toEqual(['desktop/src-tauri/Info.plist', 'docs/brand/logo.svg', 'site/sitemap.xml']);
  });
});

describe('pythonPreflight subject', () => {
  it('names the checked file kind in the unavailable reason', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(pythonPreflight(spawn as never, 'changed XML files').reason).toContain('changed XML files');
    expect(pythonPreflight(spawn as never).reason).toContain('changed .py files');
  });
});

describe('runXmlSyntaxCheck', () => {
  it('hands every changed file to one python3 -c ElementTree run', () => {
    const calls: { cmd: string; args: string[]; opts: { cwd: string } }[] = [];
    const spawn = (cmd: string, args: string[], opts: { cwd: string }) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(runXmlSyntaxCheck('/repo', ['a.xml', 'dir/b.svg', 'c.plist'], spawn as never)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('python3');
    expect(calls[0]!.args[0]).toBe('-c');
    expect(calls[0]!.args.slice(2)).toEqual(['a.xml', 'dir/b.svg', 'c.plist']);
    expect(calls[0]!.opts.cwd).toBe('/repo');
  });

  it('returns false and reports FAIL on a non-zero interpreter result', () => {
    const spawn = () => ({ status: 1, stdout: '', stderr: 'bad.svg: not well-formed (invalid token): line 2, column 9', error: undefined, signal: null });
    expect(runXmlSyntaxCheck('/repo', ['bad.svg'], spawn as never)).toBe(false);
  });

  it('returns false when the interpreter cannot be spawned', () => {
    const spawn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), signal: null });
    expect(runXmlSyntaxCheck('/repo', ['a.xml'], spawn as never)).toBe(false);
  });

  it('parses real XML, skips non-XML plists and rejects real parse errors when python3 exists', () => {
    if (!pythonPreflight().ok) return;
    const root = mkdtempSync(join(tmpdir(), 'verify-xml-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'ok.xml'), '<?xml version="1.0"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url/></urlset>\n');
      writeFileSync(join(root, 'ok.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
      writeFileSync(join(root, 'ok.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict/></plist>\n');
      writeFileSync(join(root, 'bad.svg'), '<svg><rect></svg>');
      writeFileSync(join(root, 'bad.xml'), '{"not": "xml"}');
      writeFileSync(join(root, 'empty.plist'), '');
      writeFileSync(join(root, 'ascii.plist'), '/* comment */\n{ a = 1; }\n');
      writeFileSync(join(root, 'binary.plist'), 'bplist00\x00\x01\x02not xml at all');
      expect(runXmlSyntaxCheck(root, ['ok.xml', 'ok.svg', 'ok.plist', 'ascii.plist', 'binary.plist'])).toBe(true);
      expect(runXmlSyntaxCheck(root, ['ok.xml', 'bad.svg'])).toBe(false);
      expect(runXmlSyntaxCheck(root, ['bad.xml'])).toBe(false);
      expect(runXmlSyntaxCheck(root, ['empty.plist'])).toBe(false);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
