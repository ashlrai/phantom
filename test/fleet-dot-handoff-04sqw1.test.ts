import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDotHandoff, DOT_HANDOFF_SUMMARY } from '../src/cli/fleet-dot-handoff.js';

// Offline, read-only command: no network, no filesystem, no real HOME needed.
afterEach(() => vi.restoreAllMocks());

function capture() {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { out, err };
}

describe('fleet dot-handoff', () => {
  it('prints the structured summary as JSON with honest evidence statuses', async () => {
    const { out } = capture();
    expect(await cmdFleetDotHandoff(['--json'])).toBe(0);
    expect(out).toHaveBeenCalledTimes(1);
    const summary = JSON.parse(String(out.mock.calls[0]![0]));
    expect(summary).toMatchObject({
      schema: 'fleet.dot-handoff.v1',
      observedAt: '2026-11-04',
      readOnly: true,
      offline: true,
      guide: 'docs/DOT-HANDOFF.md',
    });
    expect(summary.capabilities.length).toBeGreaterThan(0);
    for (const cap of summary.capabilities) {
      expect(['documented', 'unverified', 'separate-product']).toContain(cap.status);
      expect(cap.claim.length).toBeGreaterThan(0);
      expect(cap.sources.length).toBeGreaterThan(0);
      for (const url of cap.sources) expect(url).toMatch(/^https:\/\//);
    }
  });

  it('marks claims no official source establishes as unverified, not documented', async () => {
    const { out } = capture();
    await cmdFleetDotHandoff(['--json']);
    const summary = JSON.parse(String(out.mock.calls[0]![0]));
    const byId = Object.fromEntries(summary.capabilities.map((c: { id: string }) => [c.id, c]));
    // No invented API: personal-dot dispatch stays unverified.
    expect(byId['personal-dot-api'].status).toBe('unverified');
    expect(byId['model-identity'].status).toBe('unverified');
    // Mason's account facts are a local observation, never documentation.
    expect(summary.masonObservation).toContain('local observation');
    expect(summary.masonObservation).toContain('unverified');
    // Adjacent real surfaces are labelled separate-product, not personal-dot capability.
    expect(byId['workspace-agents-api'].status).toBe('separate-product');
    expect(byId['plugin-mcp-events'].status).toBe('separate-product');
  });

  it('distinguishes native teammate source support from unverified host delivery', async () => {
    const { out } = capture();
    await cmdFleetDotHandoff(['--json']);
    const summary = JSON.parse(String(out.mock.calls[0]![0]));
    expect(summary.transport.phantomToDot).toBe('unverified');
    expect(summary.transport.teammateTransport).toBe('available-in-source');
    expect(summary.transport.hostQualification).toBe('not-observed');
    expect(summary.repositoryObservedAt).toBe('2026-11-08');
    expect(summary.transport.reason).toContain('self-only');
    expect(summary.transport.unsupportedStep).toBe('needs-you');
    expect(summary.busContract).toMatchObject({ provider: 'openai-dot', status: 'recognized-label-only' });
    expect(summary.a2aSchema.status).toBe('configuration-only');
    expect(summary.taskTemplate['handoff-id']).toBeTruthy();
    expect(summary.nextHandoffStep).toContain('needs-you');
  });

  it('prints concise human output without JSON', async () => {
    const { out } = capture();
    expect(await cmdFleetDotHandoff([])).toBe(0);
    const text = String(out.mock.calls[0]![0]);
    expect(text).not.toContain('fleet.dot-handoff.v1');
    expect(text).toContain('Transport Phantom→dot: unverified');
    expect(text).toContain('docs/DOT-HANDOFF.md');
    expect(text).toContain('[unverified] personal-dot-api');
  });

  it('prints help and exits 0', async () => {
    const { out } = capture();
    for (const flag of ['--help', '-h']) {
      expect(await cmdFleetDotHandoff([flag])).toBe(0);
    }
    expect(String(out.mock.calls[0]![0])).toContain('Usage: ashlr fleet dot-handoff');
  });

  it('rejects bad arguments with exit 2', async () => {
    const { out, err } = capture();
    for (const args of [['--bogus'], ['--json', 'extra'], ['send', '--to', 'dot'], ['--json', '--json']]) {
      expect(await cmdFleetDotHandoff(args)).toBe(2);
    }
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith('Usage: ashlr fleet dot-handoff [--json]');
  });

  it('summary constant matches what JSON emits (single source)', async () => {
    const { out } = capture();
    await cmdFleetDotHandoff(['--json']);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(DOT_HANDOFF_SUMMARY);
  });
});
