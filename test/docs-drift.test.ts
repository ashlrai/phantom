import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error Standalone repository checker is intentionally not shipped in dist.
import { checkDocsDrift, fixPlan, main } from '../scripts/check-docs-drift.mjs';
// @ts-expect-error Standalone source adapters have no declaration output.
import { extractSource, extractHelp, extractSchema, inventory, references } from '../scripts/docs-drift/extract.mjs';
// @ts-expect-error Standalone publisher adapter has no declaration output.
import { publishFix } from '../scripts/docs-drift/publish.mjs';

const roots: string[] = [];
const profile = {
  sourceRoots: ['src'], dispatch: 'src/cli/index.ts', schema: 'schema/config.schema.json',
  binaries: ['phm', 'ashlr'], envPrefixes: ['ASHLR_'], toolPrefixes: ['ashlr_'],
  historicalPrefixes: ['docs/contracts/'], helpSnapshots: [],
  external: { tool: ['ashlr__'] },
};
const code = `
const cmd = 'run';
switch (cmd) { case 'run': break; case 'config': break; case 'status': break; }
const flags = ['--json', '--help'];
const env = { ASHLR_CHILD: 'not-a-secret' };
const enabled = process.env.ASHLR_ENABLED;
const option = process.env['ASHLR_OPTION'];
const tools = [{ name: 'ashlr_status', inputSchema: { type: 'object' } }];
// --removed and ASHLR_REMOVED must not become supported facts.
`;
const schema = {
  type: 'object', additionalProperties: false,
  properties: { models: { $ref: '#/definitions/models' }, plugins: { type: 'object', additionalProperties: true } },
  definitions: { models: { type: 'object', additionalProperties: false, properties: { providerChain: { type: 'array' } } } },
};
function fixture(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'docs-drift-'));
  roots.push(root);
  const files = {
    'package.json': JSON.stringify({ version: '1.2.3' }),
    'schema/config.schema.json': JSON.stringify(schema),
    'src/cli/index.ts': code,
    'README.md': '`phm run --json`\n`ASHLR_ENABLED`\n`ashlr_status`\n`phm config get models.providerChain`\nThis source tree targets version 1.2.3; check canonical release availability and exact matching assets before installation.\n',
    'docs/guide.md': '# Guide\n',
    'profile.json': JSON.stringify(profile), ...extra,
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('docs drift inventory and comparison', () => {
  it('checks all six kinds with source provenance, without executing source', () => {
    const root = fixture({ 'src/never-run.ts': 'throw new Error("must never execute");' });
    const report = checkDocsDrift({ root, profile });
    expect(report).toMatchObject({ ok: true, mismatches: [], coverage: { documents: 2, verifiedReferences: 7 } });
    expect(report.inventory.command).toContainEqual({ value: 'run', file: 'src/cli/index.ts', line: 3 });
    expect(report.inventory.env.map((e: { value: string }) => e.value)).toEqual(['ASHLR_CHILD', 'ASHLR_ENABLED', 'ASHLR_OPTION']);
    expect(report.inventory.config.map((e: { value: string }) => e.value)).toContain('models.providerChain');
    expect(JSON.stringify(report)).not.toContain('not-a-secret');
  });

  it.each([
    ['command', '`phm gone`', 'gone'], ['flag', '`phm run --removed`', '--removed'],
    ['env', '`ASHLR_REMOVED`', 'ASHLR_REMOVED'], ['tool', '`ashlr_removed`', 'ashlr_removed'],
    ['config', '`phm config get models.gone`', 'models.gone'], ['config', 'Config key: `models.gone`', 'models.gone'],
    ['version', 'This source tree targets version 1.0.0;', '1.0.0'],
  ])('reports known %s drift with the exact document and line', (kind, claim, value) => {
    const root = fixture({ 'docs/guide.md': `# Guide\n${claim}\n` });
    expect(checkDocsDrift({ root, profile }).mismatches).toEqual([
      expect.objectContaining({ kind, value, file: 'docs/guide.md', line: 2 }),
    ]);
  });

  it('discovers README, agent instructions, nested docs and llms files', () => {
    const root = fixture({ 'AGENTS.md': '`phm missing`', 'CLAUDE.md': '`phm missing`',
      'llms-full.txt': '`phm missing`', 'docs/nested/a.md': '`phm missing`' });
    expect(checkDocsDrift({ root, profile }).mismatches.map((f: { file: string }) => f.file)).toEqual([
      'AGENTS.md', 'CLAUDE.md', 'docs/nested/a.md', 'llms-full.txt',
    ]);
  });

  it('finds stale in-app constants without confusing protocol versions', () => {
    const root = fixture({ 'src/about.ts': 'export const APP_VERSION: string = "0.9.0"; const protocol = "0.8.0";' });
    expect(checkDocsDrift({ root, profile }).mismatches).toEqual([
      expect.objectContaining({ kind: 'version', file: 'src/about.ts', value: '0.9.0', expected: '1.2.3' }),
    ]);
  });

  it('ignores commented app versions and version strings in unrelated prose', () => {
    const root = fixture({ 'src/about.ts': '// const APP_VERSION = "0.9.0";\nconst message = "APP_VERSION = 0.9.0";' });
    expect(checkDocsDrift({ root, profile }).mismatches).toEqual([]);
  });

  it('checks plain llms commands, global flags and continued shell flags', () => {
    const root = fixture({ 'llms.txt': 'phm missing\nphm --removed\n',
      'docs/guide.md': '```sh\nphm run \\\n  --removed\n```' });
    expect(checkDocsDrift({ root, profile }).mismatches.map((f: { file: string; line: number; value: string }) => [f.file, f.line, f.value]))
      .toEqual([['docs/guide.md', 3, '--removed'], ['llms.txt', 1, 'missing'], ['llms.txt', 2, '--removed']]);
  });

  it('does not silently classify every contract or spec as historical', () => {
    const root = fixture({ 'docs/contracts/current.md': '`phm missing`', 'docs/SPEC-CURRENT.md': '# Implemented\n`phm missing`' });
    expect(checkDocsDrift({ root, profile: { ...profile, historicalPrefixes: [] } }).mismatches).toHaveLength(2);
  });

  it('does not mistake source filenames or event names for configuration keys', () => {
    const root = fixture({ 'docs/guide.md': '`models.ts` emits `models.refresh` events.' });
    expect(checkDocsDrift({ root, profile }).mismatches).toEqual([]);
  });

  it('a shell reference alone cannot hide a removed product environment name', () => {
    const root = fixture({ 'docs/guide.md': '```sh\necho "$ASHLR_REMOVED"\n```' });
    expect(checkDocsDrift({ root, profile }).mismatches).toEqual([expect.objectContaining({ kind: 'env', value: 'ASHLR_REMOVED' })]);
  });

  it('reports history, proposals, external companions and open maps for review', () => {
    const root = fixture({ 'docs/guide.md': '# Guide\n## Historical\n`phm gone`\n### Old\n`ASHLR_REMOVED`\n## Current\n`ashlr__grep`\n`phm config get plugins.custom.value`\n## Next patches\n`ashlr_future`' });
    const report = checkDocsDrift({ root, profile });
    expect(report.ok).toBe(true);
    expect(report.review.map((r: { reason: string }) => r.reason)).toEqual([
      'historical-reference', 'historical-reference', 'external-companion', 'open-schema-map', 'historical-reference',
    ]);
    writeFileSync(join(root, 'docs/guide.md'), '# Historical\n`phm gone`\n# Current\n`phm missing`');
    expect(checkDocsDrift({ root, profile }).mismatches).toHaveLength(1);
  });

  it('ignores third-party examples, quoted goals and forwarded child flags', () => {
    const root = fixture({ 'docs/guide.md': '```sh\ngit run --removed\nphm run "a --removed goal" --json -- child --not-ours\n```\n`phm run --json # --comment`\nRelease v0.1.0 introduced the protocol.' });
    expect(checkDocsDrift({ root, profile }).mismatches).toEqual([]);
  });

  it('returns shell-variable references as unknown, never verified', () => {
    const root = fixture({ 'docs/guide.md': '```sh\nASHLR_EXAMPLE=placeholder\ncurl "$ASHLR_EXAMPLE"\n```' });
    expect(checkDocsDrift({ root, profile }).review).toEqual([
      expect.objectContaining({ value: 'ASHLR_EXAMPLE', reason: 'shell-variable' }),
      expect.objectContaining({ value: 'ASHLR_EXAMPLE', reason: 'shell-variable' }),
    ]);
  });

  it('does not let help comments or test fixtures bless removed flags', () => {
    const root = fixture({ 'src/a.test.ts': 'const value = "--removed";', 'docs/guide.md': '`phm run --removed`' });
    expect(checkDocsDrift({ root, profile }).mismatches).toHaveLength(1);
  });

  it('supports Commander syntax and reviewed clap help snapshots', () => {
    const facts = inventory();
    extractSource('program.command("inspect <file>").option("--json");', 'cli.ts', facts);
    extractHelp('Commands:\n  status  Show status\nOptions:\n  --verbose  Verbose output\n', 'cli-help.txt', facts);
    expect([...facts.command.keys()]).toEqual(['inspect', 'status']);
    expect([...facts.flag.keys()]).toEqual(['--json', '--verbose']);
  });

  it('runs the shipped sibling-repository profile against a known-drift fixture', () => {
    const sibling = JSON.parse(readFileSync(join(__dirname, '../docs/examples/docs-drift-profile.json'), 'utf8'));
    const root = fixture({
      'src/cli/index.ts': 'program.command("run").option("--json"); const active = process.env.EXAMPLE_ENABLED; const tools = [{ name: "example_status", inputSchema: {} }];',
      'docs/cli-help.txt': 'Commands:\n  status  Show status\nOptions:\n  --help  Show help\n',
      'README.md': '`example removed`\n`EXAMPLE_REMOVED`\n`example_removed`',
    });
    expect(checkDocsDrift({ root, profile: sibling }).mismatches.map((f: { kind: string }) => f.kind)).toEqual(['command', 'env', 'tool']);
  });

  it('fails closed when dispatch or an inventory disappears', () => {
    const root = fixture({ 'src/cli/index.ts': code.replace('switch (cmd)', 'switch (other)') });
    expect(() => checkDocsDrift({ root, profile })).toThrow('Missing command dispatch');
    writeFileSync(join(root, 'src/cli/index.ts'), code.replace("name: 'ashlr_status'", "id: 'ashlr_status'"));
    expect(() => checkDocsDrift({ root, profile })).toThrow('Empty tool inventory');
  });

  it('fails closed on malformed source and unresolved schemas', () => {
    expect(() => extractSource('const = ;', 'broken.ts', inventory())).toThrow('Cannot parse source');
    expect(() => extractSchema({ $ref: '#/missing' }, 'schema.json', inventory())).toThrow('Unresolved');
    expect(() => extractSchema({ $ref: 'https://example.invalid/schema' }, 'schema.json', inventory())).toThrow('External');
  });

  it('bounds recursive schemas and treats descendants as unverified', () => {
    const facts = inventory();
    const open = extractSchema({ definitions: { node: { properties: { next: { $ref: '#/definitions/node' } } } },
      properties: { tree: { $ref: '#/definitions/node' } } }, 'schema.json', facts);
    expect(open.has('tree.next')).toBe(true);
  });

  it('refuses symlinked inputs and path escapes', () => {
    const root = fixture();
    const outside = fixture();
    symlinkSync(join(outside, 'README.md'), join(root, 'docs/leak.md'));
    expect(() => checkDocsDrift({ root, profile })).toThrow('Symlink refused');
    expect(() => checkDocsDrift({ root, profile: { ...profile, schema: '../outside.json' } })).toThrow();
  });

  it('does not treat a different fenced marker as a closing fence', () => {
    const refs = references('````sh\n~~~\nphm gone\n````', 'README.md', profile);
    expect(refs).toContainEqual(expect.objectContaining({ kind: 'command', value: 'gone', line: 3 }));
  });
});

describe('docs drift fix and CLI contract', () => {
  function staleFixture() {
    return fixture({ 'README.md': 'This source tree targets version 1.0.0; check canonical release availability and exact matching assets before installation.\n' });
  }
  it('plans only provable version corrections and is idempotent after application', () => {
    const root = staleFixture();
    const plan = fixPlan(root, checkDocsDrift({ root, profile }));
    expect(plan.changes).toHaveLength(1);
    expect(plan.unresolved).toEqual([]);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('1.0.0');
    writeFileSync(join(root, 'README.md'), plan.changes[0].after);
    expect(checkDocsDrift({ root, profile }).ok).toBe(true);
    expect(fixPlan(root, checkDocsDrift({ root, profile })).changes).toEqual([]);
  });

  it('never guesses a command rename or edits authority docs and application code', () => {
    const root = fixture({ 'docs/AUTHORITY.md': 'This source tree targets version 1.0.0;', 'docs/guide.md': '`phm gone`',
      'src/about.ts': 'const APP_VERSION = "1.0.0";' });
    const plan = fixPlan(root, checkDocsDrift({ root, profile }));
    expect(plan.changes).toEqual([]);
    expect(plan.unresolved).toHaveLength(3);
  });

  it('does not publish a partial version fix when another claim remains stale', () => {
    const root = fixture({ 'README.md': 'This source tree targets version 1.0.0;\nThis source tree targets version 0.8.0\n' });
    const plan = fixPlan(root, checkDocsDrift({ root, profile }));
    expect(plan.changes).toHaveLength(1);
    expect(plan.unresolved).toEqual([expect.objectContaining({ value: '0.8.0' })]);
  });

  it.each(['1.0.0', '1.2.3'])('finds and fixes every same-line version claim after %s', first => {
    const root = fixture({ 'README.md': `This source tree targets version ${first}; This source tree targets version 1.0.0;\n` });
    const report = checkDocsDrift({ root, profile });
    expect(report.mismatches).toHaveLength(first === '1.0.0' ? 2 : 1);
    const plan = fixPlan(root, report);
    expect(plan.unresolved).toEqual([]);
    writeFileSync(join(root, 'README.md'), plan.changes[0].after);
    expect(checkDocsDrift({ root, profile }).mismatches).toEqual([]);
  });

  it('retains a same-line malformed duplicate as unresolved', () => {
    const root = fixture({ 'README.md': 'This source tree targets version 1.0.0; This source tree targets version 1.0.0\n' });
    const plan = fixPlan(root, checkDocsDrift({ root, profile }));
    expect(plan.unresolved).toHaveLength(1);
    expect(plan.changes[0].after).toContain('1.0.0');
  });

  it('emits JSON, differentiates drift and clean, and keeps dry-run read-only', () => {
    const root = staleFixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = ['--root', root, '--profile', 'profile.json'];
    expect(main([...args, '--fix', '--dry-run', '--event', 'nightly'])).toBe(1);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ ok: false, fix: { status: 'dry-run' } });
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('1.0.0');
    expect(main([...args, '--fix'])).toBe(2);
    writeFileSync(join(root, 'README.md'), 'This source tree targets version 1.2.3;');
    expect(main(args)).toBe(0);
  });

  it.each([['--event', 'push'], ['--unknown'], ['--root'], ['--plan', 'a.json'], ['--dry-run']])('rejects unsupported invocation %j before scanning', (...args) => {
    expect(() => main(args)).toThrow();
  });

  function bridge(root: string) {
    const runsDir = mkdtempSync(join(tmpdir(), 'docs-drift-bridge-'));
    roots.push(runsDir);
    const publisher = join(runsDir, 'publish.sh');
    writeFileSync(publisher, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const base = 'a'.repeat(40);
    writeFileSync(join(runsDir, 'DOCS.base'), `${base} codex-bridge/DOCS ${root} codex-cmp\n`);
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'git') return { status: 0, stdout: args[0] === 'symbolic-ref' ? 'codex-bridge/DOCS\n' : args[0] === 'rev-parse' ? base : '' };
      return { status: 0, stdout: 'PRIVATE publisher log that must never be echoed' };
    });
    return { publisher, runsDir, job: 'DOCS', run };
  }

  it('hands a clean bound fix to publish.sh JOB exactly once, with no raw output', () => {
    const root = staleFixture();
    const adapter = bridge(root);
    const plan = fixPlan(root, checkDocsDrift({ root, profile }));
    const result = publishFix({ root, plan, ...adapter }, adapter.run);
    expect(result).toMatchObject({ status: 'publisher-completed', branch: 'codex-bridge/DOCS', files: ['README.md'] });
    // Never assert on complete subprocess options: a failed assertion would
    // serialize the inherited environment. Compare only non-sensitive fields.
    expect(adapter.run.mock.calls.filter(([cmd]) => cmd === 'bash').map(([cmd, args]) => [cmd, args]))
      .toEqual([['bash', [adapter.publisher, 'DOCS']]]);
    expect(adapter.run.mock.calls.some(([cmd, args]) => cmd === 'git' && args.includes(':(exclude)BRIDGE_NOTES.md'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(checkDocsDrift({ root, profile }).ok).toBe(true);
  });

  it.each(['dirty', 'wrong-root', 'unsafe-publisher', 'stale-plan', 'unresolved'])('refuses %s before any writes or publisher calls', condition => {
    const root = staleFixture();
    const adapter = bridge(root);
    const plan = fixPlan(root, checkDocsDrift({ root, profile }));
    if (condition === 'dirty') adapter.run.mockImplementation(() => ({ status: 0, stdout: 'dirty' }));
    if (condition === 'wrong-root') writeFileSync(join(adapter.runsDir, 'DOCS.base'), `${'a'.repeat(40)} codex-bridge/DOCS ${adapter.runsDir} pool`);
    if (condition === 'unsafe-publisher') chmodSync(adapter.publisher, 0o777);
    if (condition === 'stale-plan') plan.changes[0].before = 'unexpected';
    if (condition === 'unresolved') plan.unresolved.push({ kind: 'command' });
    expect(() => publishFix({ root, plan, ...adapter }, adapter.run)).toThrow();
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('1.0.0');
    expect(adapter.run.mock.calls.some(([cmd]) => cmd === 'bash')).toBe(false);
  });

  it('reports publisher failures honestly and retains the inspectable patch', () => {
    const root = staleFixture();
    const adapter = bridge(root);
    const original = adapter.run.getMockImplementation()!;
    adapter.run.mockImplementation((cmd, args) => cmd === 'bash' ? { status: 1, stdout: 'private failure' } : original(cmd, args));
    const plan = fixPlan(root, checkDocsDrift({ root, profile }));
    expect(publishFix({ root, plan, ...adapter }, adapter.run)).toMatchObject({ status: 'publisher-failed', exitCode: 1 });
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('1.2.3');
  });
});
