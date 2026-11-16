/**
 * Capability registry (PHANTOM-OS-1 PR 1): schema, loader, surface/model/edge
 * separation, sensitivity flags, reference-only accounts, control backends,
 * loopback-only local models, adapter generation (sha-stable) and the
 * output-directory guard. Hermetic: temp dirs only, injected home.
 */

import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCapsAdapters, sha256, stableJson } from '../src/core/caps/generate.js';
import { assertSafeOutputDir, checkCapsBundle, writeCapsBundle } from '../src/core/caps/output.js';
import {
  DEFAULT_CAPS_REGISTRY_PATH,
  gatedCapabilities,
  loadCapsRegistry,
  parseCapsRegistry,
  resolveSurfaceModelPair,
  surfaceModelPairs,
  validateCapsRegistry,
} from '../src/core/caps/registry.js';
import type { CapsRegistry } from '../src/core/caps/schema.js';
import { capsGenerate, capsList, capsValidate } from '../src/core/caps/service.js';
import { cmdCaps } from '../src/cli/caps.js';

const REPO = resolve(import.meta.dirname, '..');
const FIXTURE = join(REPO, 'test/fixtures/caps/minimal.registry.json');
const fixture = (): Record<string, any> => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const issuesOf = (value: unknown): Array<{ path: string; message: string }> => {
  const r = validateCapsRegistry(value);
  return r.ok ? [] : r.issues;
};
const expectIssue = (value: unknown, path: string | RegExp, message?: RegExp): void => {
  const issues = issuesOf(value);
  const hit = issues.find((i) => (typeof path === 'string' ? i.path === path : path.test(i.path)) && (!message || message.test(i.message)));
  expect(hit, JSON.stringify(issues)).toBeTruthy();
};

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'caps-')); });

describe('load and validate', () => {
  it('the in-repo registry is valid', async () => {
    const reg = await loadCapsRegistry(DEFAULT_CAPS_REGISTRY_PATH);
    expect(reg.schema).toBe('caps.registry.v1');
    expect(reg.surfaces.length).toBeGreaterThan(10);
  });

  it('the fixture is valid', () => {
    expect(validateCapsRegistry(fixture())).toMatchObject({ ok: true });
  });

  it('rejects unknown fields (closed objects) and wrong schema ids', () => {
    expectIssue({ ...fixture(), extra: 1 }, '(root)');
    expectIssue({ ...fixture(), schema: 'caps.registry.v2' }, 'schema');
  });

  it('rejects duplicate ids and broken references', () => {
    const doc = fixture();
    doc.surfaces.push({ ...doc.surfaces[0] });
    doc.capabilities[0].surfaces.push('nope');
    doc.capabilities[1].accounts.push('ghost');
    const issues = issuesOf(doc);
    expect(issues.some((i) => /Duplicate surfaces id "claude-code"/.test(i.message))).toBe(true);
    expect(issues.some((i) => /Unknown surface "nope"/.test(i.message))).toBe(true);
    expect(issues.some((i) => /Unknown account "ghost"/.test(i.message))).toBe(true);
  });

  it('anchors on the router: engines and catalog ids must exist, provider ids must match', () => {
    const a = fixture(); a.surfaces[0].engine = 'not-an-engine';
    expectIssue(a, 'surfaces[0].engine', /engine-registry/);
    const b = fixture(); b.models[0].catalogId = 'claude:invented-model';
    expectIssue(b, 'models[0].catalogId', /KNOWN_MODELS/);
    const c = fixture(); c.models[0].providerModelId = 'claude-sonnet-5-5';
    expectIssue(c, 'models[0].providerModelId', /claude-opus-5-5/);
  });

  it('reports invalid JSON files without echoing their content', async () => {
    const file = join(tmp, 'bad.json');
    writeFileSync(file, '{ "token": "not json');
    const result = await capsValidate({ registry: file, cwd: tmp, home: tmp });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('not json');
  });
});

describe('surfaces, models and hosting edges', () => {
  const reg = (): CapsRegistry => parseCapsRegistry(fixture());

  it('Fable 5.2 is a Claude-lane model with the Max weekly Fable allowance, not a surface', () => {
    const r = reg();
    const fable = r.models.find((m) => m.id === 'claude-fable-5-2')!;
    expect(fable).toMatchObject({ lane: 'claude', family: 'claude-fable', allowance: 'claude-max-weekly-fable', catalogId: 'claude:claude-fable-5-2' });
    expect(r.surfaces.some((s) => /fable/.test(s.id))).toBe(false);
    const pair = resolveSurfaceModelPair(r, 'claude-code', 'claude-fable-5-2');
    expect(pair).toEqual({ ok: true, pair: { surface: 'claude-code', model: 'claude-fable-5-2', catalogId: 'claude:claude-fable-5-2', via: [] } });
  });

  it('the repo registry models Fable the same way and pins the Weyv lead to it', async () => {
    const r = await loadCapsRegistry();
    expect(r.models.find((m) => m.id === 'claude-fable-5-2')).toMatchObject({ lane: 'claude', allowance: 'claude-max-weekly-fable' });
    expect(r.models.filter((m) => m.lane === 'claude').map((m) => m.family)).toEqual(expect.arrayContaining(['claude-opus', 'claude-sonnet', 'claude-fable']));
    expect(r.sessions.find((s) => s.id === 'weyv-lead')).toMatchObject({ surface: 'claude-code', model: 'claude-fable-5-2' });
    for (const s of r.surfaces) expect(s.id).not.toMatch(/fable/);
  });

  it('a model is never accepted where a surface is expected and vice versa', () => {
    const r = reg();
    expect(resolveSurfaceModelPair(r, 'claude-code', 'codex-cli')).toEqual({ ok: false, reason: '"codex-cli" is a surface, not a model.' });
    expect(resolveSurfaceModelPair(r, 'claude-fable-5-2', 'claude-opus-5-5')).toMatchObject({ ok: false, reason: expect.stringMatching(/Unknown surface/) });
    const clash = fixture();
    clash.models.push({ ...clash.models[0], id: 'codex-cli' });
    expect(issuesOf(clash).some((i) => /names both a surface and a model/.test(i.message))).toBe(true);
  });

  it('pairs only within a lane', () => {
    const r = reg();
    expect(resolveSurfaceModelPair(r, 'codex-cli', 'claude-opus-5-5')).toMatchObject({ ok: false, reason: expect.stringMatching(/lane claude.*lane codex/) });
    const pairs = surfaceModelPairs(r);
    for (const p of pairs) {
      expect(r.models.find((m) => m.id === p.model)!.lane).toBe(r.surfaces.find((s) => s.id === p.surface)!.lane);
    }
  });

  it('hosting edges are first-class: hosted-only surfaces route through their host', () => {
    const r = reg();
    expect(resolveSurfaceModelPair(r, 'glm-lite', 'glm-5.3')).toEqual({ ok: true, pair: { surface: 'glm-lite', model: 'glm-5.3', catalogId: null, via: ['devin-cli'] } });
    const orphan = fixture();
    orphan.hosting = orphan.hosting.filter((e: { guest: string }) => e.guest !== 'glm-lite');
    expectIssue(orphan, 'surfaces[4].hostedOnly', /no hosting edge/);
  });

  it('rejects self-hosting, unknown ends, duplicate edges and cycles', () => {
    const self = fixture(); self.hosting.push({ host: 'codex-cli', guest: 'codex-cli', via: 'x' });
    expect(issuesOf(self).some((i) => /cannot host itself/.test(i.message))).toBe(true);
    const unknown = fixture(); unknown.hosting.push({ host: 'nobody', guest: 'codex-cli', via: 'x' });
    expectIssue(unknown, 'hosting[2].host', /Unknown host/);
    const dup = fixture(); dup.hosting.push({ ...dup.hosting[0] });
    expect(issuesOf(dup).some((i) => /Duplicate hosting edge/.test(i.message))).toBe(true);
    const cyc = fixture();
    cyc.hosting.push({ host: 'gemini-cli', guest: 'codex-cli', via: 'x' }, { host: 'codex-cli', guest: 'devin-cli', via: 'x' });
    expectIssue(cyc, 'hosting', /cycle/);
  });

  it('the repo registry has Devin hosting the required agents on both Devin surfaces', async () => {
    const r = await loadCapsRegistry();
    for (const host of ['devin-cli', 'devin-desktop']) {
      const guests = r.hosting.filter((e) => e.host === host).map((e) => e.guest);
      expect(guests).toEqual(expect.arrayContaining(['glm-lite', 'cursor-agent', 'grok-build', 'gemini-cli', 'copilot-cli', 'qwen-code', 'codex-cli']));
    }
    const kinds = new Set(r.surfaces.map((s) => s.id));
    for (const required of ['claude-code', 'claude-desktop', 'codex-cli', 'codex-desktop', 'devin-cli', 'devin-desktop', 'cursor-desktop', 'cursor-cloud', 'grok-bot-desktop', 'local-omlx']) {
      expect(kinds.has(required), required).toBe(true);
    }
  });

  it('sessions must name a valid pair and capabilities enabled on that surface', () => {
    const bad = fixture(); bad.sessions[0].model = 'gpt-6.1-sol';
    expectIssue(bad, 'sessions[0]', /does not run on surface/);
    const cap = fixture(); cap.sessions[0].capabilities.push('browser-verify'); cap.sessions[0].surface = 'claude-code';
    expect(validateCapsRegistry(cap).ok).toBe(true);
    cap.capabilities[3].surfaces = ['codex-cli'];
    expectIssue(cap, 'sessions[0].capabilities[1]', /not enabled on surface/);
  });
});

describe('sensitivity flags and hard-limit gates', () => {
  it('flagged capabilities require the matching hard-limit gate', () => {
    for (const [flag, gate] of [['external_send', 'outside-send'], ['spend', 'money'], ['delete', 'destroy-data']] as const) {
      const doc = fixture();
      doc.capabilities[0].sensitivity[flag] = true;
      expectIssue(doc, 'capabilities[0].hardLimitGates', new RegExp(`sensitivity.${flag} requires hard-limit gate "${gate}"`));
      doc.capabilities[0].hardLimitGates = [gate];
      expect(validateCapsRegistry(doc).ok).toBe(true);
    }
  });

  it('send, spend and delete effects require their flag', () => {
    for (const [effect, flag] of [['send-mail', 'external_send'], ['send-message', 'external_send'], ['post-slack', 'external_send'], ['post-public', 'external_send'], ['spend', 'spend'], ['plan-change', 'spend'], ['delete-data', 'delete']] as const) {
      const doc = fixture();
      doc.capabilities[0].effects = [effect];
      expectIssue(doc, `capabilities[0].sensitivity.${flag}`, new RegExp(effect));
    }
  });

  it('sensitivity flags are required, never defaulted', () => {
    const doc = fixture();
    delete doc.capabilities[0].sensitivity.delete;
    expectIssue(doc, 'capabilities[0].sensitivity.delete');
  });

  it('the repo registry gates Mail, Messages and Slack sends', async () => {
    const r = await loadCapsRegistry();
    const gated = new Map(gatedCapabilities(r).map((c) => [c.id, c]));
    for (const id of ['mail-send', 'messages-send', 'slack-post']) {
      expect(gated.get(id)?.sensitivity.external_send, id).toBe(true);
      expect(gated.get(id)?.hardLimitGates).toContain('outside-send');
    }
    expect([...gated.values()].some((c) => c.sensitivity.spend)).toBe(true);
    expect([...gated.values()].some((c) => c.sensitivity.delete)).toBe(true);
  });
});

describe('reference-only accounts', () => {
  it('rejects value fields on accounts', () => {
    for (const key of ['value', 'token', 'secret', 'password', 'apiKey']) {
      const doc = fixture();
      doc.accounts[0][key] = 'placeholder';
      expect(validateCapsRegistry(doc).ok, key).toBe(false);
    }
  });

  it('rejects secret-shaped text anywhere and never echoes it', () => {
    const leaked = ['ghp_', 'A'.repeat(36)].join('');
    for (const place of ['scopes', 'description'] as const) {
      const doc = fixture();
      if (place === 'scopes') doc.accounts[0].scopes = [leaked];
      else doc.capabilities[0].description = `uses ${leaked}`;
      const result = validateCapsRegistry(doc);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(leaked);
    }
  });

  it('credential names are vault names, not values; only host sessions may omit them', () => {
    const lower = fixture(); lower.accounts[0].credentialName = 'xoxb-something';
    expectIssue(lower, 'accounts[0].credentialName');
    const none = fixture(); none.accounts[0].credentialName = null;
    expectIssue(none, 'accounts[0].credentialName', /host-session/);
    none.accounts[0].store = 'host-session';
    expect(validateCapsRegistry(none).ok).toBe(true);
  });

  it('launch env maps variable names to accounts the capability lists', () => {
    const doc = fixture(); doc.capabilities[1].accounts = [];
    expectIssue(doc, 'capabilities[1].launch.env[0].account', /must be listed/);
    const dup = fixture(); dup.capabilities[1].launch.env.push({ ...dup.capabilities[1].launch.env[0] });
    expectIssue(dup, 'capabilities[1].launch.env[1].name', /Duplicate/);
  });
});

describe('control backends, local surfaces and auto-file metadata', () => {
  it('refuses TCC DB, app DB, scraping and out-of-band TCC grants by name', () => {
    for (const backend of ['tcc-db', 'tcc-grant', 'app-db', 'scrape', 'screen-scrape']) {
      const doc = fixture();
      doc.capabilities[3].control = { backend };
      expectIssue(doc, 'capabilities[3].control.backend', /is refused/);
    }
  });

  it('accepts the allowed backends and rejects unknown ones', () => {
    for (const backend of ['ax', 'applescript', 'jxa', 'shortcuts', 'app-cli', 'url-scheme']) {
      const doc = fixture();
      doc.capabilities[3].control = { backend };
      expect(validateCapsRegistry(doc).ok, backend).toBe(true);
    }
    const doc = fixture(); doc.capabilities[3].control = { backend: 'xdotool' };
    expectIssue(doc, 'capabilities[3].control.backend', /Unknown control backend/);
  });

  it('CDP/Playwright needs a per-run profile on loopback', () => {
    const doc = fixture(); delete doc.capabilities[3].control.profile;
    expectIssue(doc, 'capabilities[3].control', /per-run/);
    const wide = fixture(); wide.capabilities[3].control.bind = '0.0.0.0';
    expectIssue(wide, 'capabilities[3].control.bind');
  });

  it('local model surfaces bind 127.0.0.1, never forward keys and reference an egress allowlist', () => {
    const missing = fixture(); delete missing.surfaces[5].network;
    expectIssue(missing, 'surfaces[5].network', /127\.0\.0\.1/);
    const open = fixture(); open.surfaces[5].network.bind = '0.0.0.0';
    expectIssue(open, 'surfaces[5].network.bind');
    const keys = fixture(); keys.surfaces[5].network.keyForwarding = true;
    expectIssue(keys, 'surfaces[5].network.keyForwarding');
    const egress = fixture(); egress.surfaces[5].network.egressAllowlistRef = 'open';
    expectIssue(egress, 'surfaces[5].network.egressAllowlistRef', /not defined/);
    const remote = fixture(); remote.surfaces[0].network = { ...remote.surfaces[5].network };
    expectIssue(remote, 'surfaces[0].network', /Only local-runtime/);
  });

  it('auto-file metadata cannot carry screen contents or secret values', () => {
    for (const field of ['screen-contents', 'screenshot', 'clipboard', 'window-text', 'secret-value', 'token']) {
      const doc = fixture();
      doc.capabilities[3].autoFile.fields = ['capability-id', field];
      expectIssue(doc, 'capabilities[3].autoFile.fields[1]');
    }
  });
});

describe('adapter generator', () => {
  const bundle = () => generateCapsAdapters(parseCapsRegistry(fixture()));

  it('is deterministic and sha-stable (pinned fixture digest)', () => {
    const a = bundle();
    const b = bundle();
    expect(b.manifestContent).toBe(a.manifestContent);
    expect(a.artifacts.map((x) => x.content)).toEqual(b.artifacts.map((x) => x.content));
    // Changing this digest means generator output changed: review and re-pin.
    expect(a.bundleSha256).toBe(FIXTURE_BUNDLE_SHA256);
  });

  it('every artifact has a sha; SHA256SUMS and the bundle sha cover them all', () => {
    const b = bundle();
    for (const a of b.artifacts) expect(a.sha256).toBe(sha256(a.content));
    const sums = b.artifacts.find((a) => a.path === 'SHA256SUMS')!.content;
    for (const a of b.artifacts.filter((x) => x.path !== 'SHA256SUMS')) expect(sums).toContain(`${a.sha256}  ${a.path}\n`);
    expect(b.bundleSha256).toBe(sha256(sums));
    expect(b.manifest.pinStage).toEqual({
      tool: 'SEC-PIN-STAGE-TOOL-2', lib: 'pin_stage_lib', libRev: 'fe77a6a8',
      stagedRoot: '~/.ashlr-runs/staged/caps', stagedDir: `~/.ashlr-runs/staged/caps/${b.bundleSha256}`,
    });
  });

  it('emits configs for every agent format, the Fable session and Devin hosted surfaces', () => {
    const paths = bundle().artifacts.map((a) => a.path);
    expect(paths).toEqual(expect.arrayContaining([
      'claude-code/claude-code.mcp.json', 'claude-code/claude-code.settings.json', 'codex/codex-cli.config.toml',
      'devin/devin-cli.json', 'gemini/gemini-cli.settings.json', 'local-model/local-omlx.json',
      'sessions/weyv-lead.mcp.json', 'sessions/weyv-lead.settings.json', 'SHA256SUMS',
    ]));
    const b = bundle();
    const session = JSON.parse(b.artifacts.find((a) => a.path === 'sessions/weyv-lead.settings.json')!.content);
    expect(session.model).toBe('claude-fable-5-2');
    const devin = JSON.parse(b.artifacts.find((a) => a.path === 'devin/devin-cli.json')!.content);
    expect(devin.hosted.map((h: { surface: string }) => h.surface)).toEqual(['gemini-cli', 'glm-lite']);
    expect(Object.keys(devin.hosted[0].mcpServers)).toEqual(['phantom-gateway', 'web-search']);
    const local = JSON.parse(b.artifacts.find((a) => a.path === 'local-model/local-omlx.json')!.content);
    expect(local).toMatchObject({ bind: '127.0.0.1', keyForwarding: false, egress: { allowlistRef: 'no-egress', hosts: [] } });
  });

  it('gated capabilities are never loaded directly and Claude Code denies them', () => {
    const b = bundle();
    for (const a of b.artifacts) expect(a.content, a.path).not.toMatch(/slack-mcp/);
    expect(b.manifest.gated).toEqual([{ capability: 'slack-post', surfaces: ['claude-code', 'codex-cli'], flags: ['external_send'], hardLimitGates: ['outside-send'] }]);
    const settings = JSON.parse(b.artifacts.find((a) => a.path === 'claude-code/claude-code.settings.json')!.content);
    expect(settings.permissions.deny).toEqual(['mcp__slack-post']);
  });

  it('credentials appear as host-expanded references, in each host syntax', () => {
    const b = bundle();
    const get = (p: string) => b.artifacts.find((a) => a.path === p)!.content;
    expect(JSON.parse(get('claude-code/claude-code.mcp.json')).mcpServers['web-search'].env).toEqual({ SEARCH_API_KEY: '${SEARCH_API_KEY}' });
    expect(JSON.parse(get('gemini/gemini-cli.settings.json')).mcpServers['web-search'].env).toEqual({ SEARCH_API_KEY: '$SEARCH_API_KEY' });
    expect(get('codex/codex-cli.config.toml')).toContain('env_vars = [ "SEARCH_API_KEY" ]');
  });

  it('the committed capabilities/generated output matches the registry', async () => {
    const reg = await loadCapsRegistry();
    const drift = await checkCapsBundle(generateCapsAdapters(reg), join(REPO, 'capabilities/generated'));
    expect(drift, 'run: phm caps generate').toEqual({ ok: true, changed: [], missing: [], stale: [] });
  });

  it('companion MCP launch specs match the repo .mcp.json (no second source of truth drifting)', async () => {
    const reg = await loadCapsRegistry();
    const mcp = JSON.parse(readFileSync(join(REPO, '.mcp.json'), 'utf8')).mcpServers as Record<string, { command: string; args: string[] }>;
    for (const [id, spec] of Object.entries(mcp)) {
      const cap = reg.capabilities.find((c) => c.id === id);
      expect(cap?.launch, id).toMatchObject({ command: spec.command, args: spec.args });
    }
  });

  it('stableJson sorts keys and ends with a newline', () => {
    expect(stableJson({ b: 1, a: { d: 1, c: 2 } })).toBe('{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n');
  });
});

describe('output guard: never live config dirs', () => {
  let repo: string;
  let home: string;
  beforeEach(() => {
    repo = join(tmp, 'repo');
    home = join(tmp, 'home');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'capabilities'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(repo, 'capabilities/registry.v1.json'), readFileSync(FIXTURE));
  });

  it('refuses ~/.codex and every other live agent dir in home', () => {
    for (const dir of ['.codex', '.claude', '.cursor', '.gemini', '.devin', '.config/x', 'Library/Application Support/Claude']) {
      expect(() => assertSafeOutputDir(join(home, dir), { repoRoot: repo, home }), dir).toThrow();
    }
  });

  it('refuses live config segments inside the repo and paths outside both roots', () => {
    for (const dir of ['.claude', '.cursor', '.vscode', '.codex/out', 'staging/.mcp.json']) {
      expect(() => assertSafeOutputDir(join(repo, dir), { repoRoot: repo, home }), dir).toThrow(/live agent config/);
    }
    expect(() => assertSafeOutputDir(repo, { repoRoot: repo, home })).toThrow(/subdirectory/);
    expect(() => assertSafeOutputDir(join(tmp, 'elsewhere'), { repoRoot: repo, home })).toThrow(/subdirectory/);
  });

  it('refuses a symlink in the repo that points into ~/.codex', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    symlinkSync(join(home, '.codex'), join(repo, 'sneaky'));
    expect(() => assertSafeOutputDir(join(repo, 'sneaky', 'out'), { repoRoot: repo, home })).toThrow();
  });

  it('generate writes under the worktree, then --check passes and stale files are removed', async () => {
    const first = await capsGenerate({ cwd: repo, home });
    expect(first).toMatchObject({ ok: true, mode: 'write', outDir: expect.stringContaining(join('repo', 'capabilities', 'generated')) });
    expect(existsSync(join(home, '.codex'))).toBe(false);
    const check = await capsGenerate({ cwd: repo, home, check: true });
    expect(check).toMatchObject({ ok: true, mode: 'check' });

    const doc = fixture();
    doc.surfaces = doc.surfaces.filter((s: { id: string }) => s.id !== 'gemini-cli');
    doc.hosting = doc.hosting.filter((e: { guest: string }) => e.guest !== 'gemini-cli');
    for (const c of doc.capabilities) c.surfaces = c.surfaces.filter((s: string) => s !== 'gemini-cli');
    writeFileSync(join(repo, 'capabilities/registry.v1.json'), JSON.stringify(doc));
    const drift = await capsGenerate({ cwd: repo, home, check: true });
    expect(drift.ok).toBe(false);
    const second = await capsGenerate({ cwd: repo, home });
    expect(second).toMatchObject({ ok: true, removed: ['gemini/gemini-cli.settings.json'] });
    expect(existsSync(join(repo, 'capabilities/generated/gemini/gemini-cli.settings.json'))).toBe(false);
  });

  it('--pin-stage stages under ~/.ashlr-runs/staged/caps/<bundle sha>/', async () => {
    const result = await capsGenerate({ cwd: repo, home, pinStage: true });
    if (!result.ok || result.mode !== 'write') throw new Error('generate failed');
    expect(result.outDir).toBe(join(realpathSync(home), '.ashlr-runs/staged/caps', result.bundleSha256));
    expect(readdirSync(result.outDir)).toEqual(expect.arrayContaining(['SHA256SUMS', 'manifest.json']));
    // Nothing besides the staging tree was created in home.
    expect(readdirSync(home)).toEqual(['.ashlr-runs']);
  });

  it('refuses an explicit --out into ~/.codex', async () => {
    await expect(capsGenerate({ cwd: repo, home, out: join(home, '.codex') })).rejects.toThrow();
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it('writeCapsBundle refuses unsafe roots before touching disk', async () => {
    const b = generateCapsAdapters(parseCapsRegistry(fixture()));
    await expect(writeCapsBundle(b, join(home, '.codex', 'caps'), { repoRoot: repo, home })).rejects.toThrow();
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });
});

describe('phm caps CLI', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const out = (): string => log.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { log.mockRestore(); err.mockRestore(); });

  it('--help exits 0 without acting', async () => {
    expect(await cmdCaps(['--help'])).toBe(0);
    expect(out()).toContain('Usage: phm caps');
  });

  it('bad verbs and flags exit 2', async () => {
    expect(await cmdCaps(['frobnicate'])).toBe(2);
    expect(await cmdCaps([])).toBe(2);
    expect(await cmdCaps(['list', '--out', 'x'])).toBe(2);
    expect(await cmdCaps(['validate', '--bogus', '--json'])).toBe(2);
    expect(JSON.parse(out().split('\n').at(-1)!)).toMatchObject({ ok: false });
  });

  it('validate --json passes on the fixture and fails on a broken registry', async () => {
    expect(await cmdCaps(['validate', '--registry', FIXTURE, '--json'])).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ ok: true, counts: { surfaces: 6, models: 5 } });
    const bad = join(tmp, 'bad.json');
    const doc = fixture(); doc.capabilities[3].control = { backend: 'tcc-db' };
    writeFileSync(bad, JSON.stringify(doc));
    log.mockClear();
    expect(await cmdCaps(['validate', '--registry', bad, '--json'])).toBe(1);
    expect(JSON.parse(out()).issues[0].message).toMatch(/TCC/);
  });

  it('list --json shows pairs, hosting and reference-only accounts', async () => {
    expect(await cmdCaps(['list', '--registry', FIXTURE, '--json'])).toBe(0);
    const view = JSON.parse(out());
    expect(view.pairs).toContainEqual({ surface: 'glm-lite', model: 'glm-5.3', catalogId: null, via: ['devin-cli'] });
    expect(view.accounts[0]).toEqual({ id: 'slack-bot', provider: 'slack', store: 'phantom-secrets', credentialName: 'SLACK_BOT_TOKEN', scopes: ['chat:write'] });
  });

  it('generate --check against the committed adapters passes (read-only)', async () => {
    expect(await cmdCaps(['generate', '--check', '--json'])).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ ok: true, mode: 'check' });
  });

  it('service list reports the same view', async () => {
    const view = await capsList({ registry: FIXTURE, cwd: tmp, home: tmp });
    expect(view.ok).toBe(true);
  });
});

// Pinned digest for test/fixtures/caps/minimal.registry.json. See the
// "sha-stable" test: update only when a generator change is intended.
const FIXTURE_BUNDLE_SHA256 = '2977271bd3ab22adbd0c0dcdb8a3a213b6cdd3c0e884cf7561db71c25120d3ac';
