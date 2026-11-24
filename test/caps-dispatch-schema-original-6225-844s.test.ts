import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS_REGISTRY_PATH, parseCapsRegistry, validateCapsRegistry } from '../src/core/caps/registry.js';
import { BUILTIN_ENGINE_REGISTRY } from '../src/core/run/engine-registry.js';

const fixture = () => JSON.parse(readFileSync(DEFAULT_CAPS_REGISTRY_PATH, 'utf8'));
const engine = (kind: 'cli-agent' | 'api-model') => {
  const entry = Object.entries(BUILTIN_ENGINE_REGISTRY).find(([, value]) => value.kind === kind);
  if (!entry) throw new Error(`Missing builtin ${kind} engine`);
  return entry[0];
};
const issueAt = (doc: unknown, path: string) => {
  const result = validateCapsRegistry(doc);
  expect(result.ok).toBe(false);
  expect(result.issues.some((issue) => issue.path === path), JSON.stringify(result.issues)).toBe(true);
};

describe('explicit surface dispatch metadata', () => {
  it('preserves omitted metadata and accepts valid CLI, local and hosted declarations', () => {
    const doc = fixture();
    expect(validateCapsRegistry(doc).ok).toBe(true);
    const cli = doc.surfaces.findIndex((s: { kind: string; hostedOnly: boolean }) => s.kind === 'cli' && !s.hostedOnly);
    const local = doc.surfaces.findIndex((s: { kind: string }) => s.kind === 'local-runtime');
    const hosted = doc.surfaces.findIndex((s: { hostedOnly: boolean }) => s.hostedOnly);
    expect(Math.min(cli, local, hosted)).toBeGreaterThanOrEqual(0);
    doc.surfaces[cli].engine = engine('cli-agent'); doc.surfaces[cli].dispatch = 'engine';
    doc.surfaces[local].engine = engine('api-model'); doc.surfaces[local].dispatch = 'engine';
    doc.surfaces[hosted].dispatch = 'hosted';
    expect(parseCapsRegistry(doc).surfaces[cli].dispatch).toBe('engine');
    doc.surfaces[cli].dispatch = 'unavailable';
    expect(validateCapsRegistry(doc).ok).toBe(true);
  });

  it('rejects missing or unknown engines, hosted engine use and mismatched transports', () => {
    const base = fixture();
    const cli = base.surfaces.findIndex((s: { kind: string; hostedOnly: boolean }) => s.kind === 'cli' && !s.hostedOnly);
    const local = base.surfaces.findIndex((s: { kind: string }) => s.kind === 'local-runtime');
    const hosted = base.surfaces.findIndex((s: { hostedOnly: boolean }) => s.hostedOnly);
    for (const [index, value] of [
      [cli, undefined], [cli, 'unknown-engine-844s'], [cli, engine('api-model')],
      [local, engine('cli-agent')], [hosted, engine('cli-agent')],
    ] as const) {
      const doc = structuredClone(base); doc.surfaces[index].dispatch = 'engine';
      doc.surfaces[index].engine = value;
      issueAt(doc, `surfaces[${index}].dispatch`);
    }
    for (const kind of ['desktop', 'cloud', 'bot']) {
      const doc = structuredClone(base); doc.surfaces[cli].kind = kind;
      doc.surfaces[cli].engine = engine('cli-agent'); doc.surfaces[cli].dispatch = 'engine';
      issueAt(doc, `surfaces[${cli}].dispatch`);
    }
  });

  it('rejects invalid declarations and preserves strict fields and local loopback', () => {
    const doc = fixture();
    const cli = doc.surfaces.findIndex((s: { kind: string; hostedOnly: boolean }) => s.kind === 'cli' && !s.hostedOnly);
    const local = doc.surfaces.findIndex((s: { kind: string }) => s.kind === 'local-runtime');
    doc.surfaces[cli].dispatch = 'hosted'; issueAt(doc, `surfaces[${cli}].dispatch`);
    doc.surfaces[cli].dispatch = 'other'; issueAt(doc, `surfaces[${cli}].dispatch`);
    delete doc.surfaces[cli].dispatch; doc.surfaces[cli].extra = true;
    issueAt(doc, `surfaces[${cli}]`);
    delete doc.surfaces[cli].extra; doc.surfaces[local].network.bind = '0.0.0.0';
    issueAt(doc, `surfaces[${local}].network.bind`);
  });
});
