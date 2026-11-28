import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateCapsAdapters } from '../src/core/caps/generate.js';
import {
  activeSensitivityFlags,
  compareById,
  hostsForSurface,
  isGatedCapability,
  lookupBuiltinEngine,
  parseCapsRegistry,
} from '../src/core/caps/registry.js';
import { capsList } from '../src/core/caps/service.js';

const REPO = resolve(import.meta.dirname, '..');
const FIXTURE_PATH = join(REPO, 'test/fixtures/caps/minimal.registry.json');
const loadFixtureRegistry = () => parseCapsRegistry(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));

describe('caps shared registry and sensitivity helpers', () => {
  it('sorts named entries deterministically by id', () => {
    const items = [{ id: 'zeta' }, { id: 'alpha' }, { id: 'middle' }];
    expect([...items].sort(compareById).map((item) => item.id)).toEqual(['alpha', 'middle', 'zeta']);
  });

  it('looks up builtin engines safely without traversing Object.prototype', () => {
    expect(lookupBuiltinEngine('claude')?.kind).toBe('cli-agent');
    expect(lookupBuiltinEngine('local-coder')?.kind).toBe('api-model');
    expect(lookupBuiltinEngine(undefined)).toBeUndefined();
    expect(lookupBuiltinEngine('not-a-real-engine')).toBeUndefined();
    expect(lookupBuiltinEngine('toString')).toBeUndefined();
    expect(lookupBuiltinEngine('constructor')).toBeUndefined();
  });

  it('derives active sensitivity flags and gating consistently from canonical flags', () => {
    const ungated = { sensitivity: { external_send: false, spend: false, delete: false } };
    const single = { sensitivity: { external_send: false, spend: true, delete: false } };
    const multi = { sensitivity: { external_send: true, spend: false, delete: true } };

    expect(activeSensitivityFlags(ungated)).toEqual([]);
    expect(isGatedCapability(ungated)).toBe(false);

    expect(activeSensitivityFlags(single)).toEqual(['spend']);
    expect(isGatedCapability(single)).toBe(true);

    expect(activeSensitivityFlags(multi)).toEqual(['external_send', 'delete']);
    expect(isGatedCapability(multi)).toBe(true);
  });

  it('resolves sorted direct host surfaces and agrees across generator and service views', async () => {
    const reg = loadFixtureRegistry();
    expect(hostsForSurface(reg, 'glm-lite')).toEqual(['devin-cli']);
    expect(hostsForSurface(reg, 'claude-code')).toEqual([]);

    const synthetic = {
      hosting: [
        { host: 'host-z', guest: 'guest-a', via: 'subagent' },
        { host: 'host-a', guest: 'guest-a', via: 'subagent' },
        { host: 'host-m', guest: 'guest-b', via: 'subagent' },
      ],
    };
    expect(hostsForSurface(synthetic, 'guest-a')).toEqual(['host-a', 'host-z']);

    const bundle = generateCapsAdapters(reg);
    const listView = await capsList({ registry: FIXTURE_PATH });
    expect(listView.ok).toBe(true);
    if (!listView.ok) return;

    for (const surface of listView.surfaces) {
      expect(surface.hosts).toEqual(hostsForSurface(reg, surface.id));
      expect(bundle.manifest.surfaces[surface.id]?.hosts).toEqual(surface.hosts);
    }

    const checksumsArtifact = bundle.artifacts.find((artifact) => artifact.path === 'SHA256SUMS');
    expect(checksumsArtifact?.sha256).toBe(bundle.bundleSha256);

    for (const gated of bundle.manifest.gated) {
      const cap = reg.capabilities.find((entry) => entry.id === gated.capability)!;
      expect(gated.flags).toEqual(activeSensitivityFlags(cap));
      expect(listView.capabilities.find((entry) => entry.id === gated.capability)?.flags).toEqual(gated.flags);
    }
  });
});
