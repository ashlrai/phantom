import { describe, expect, it } from 'vitest';
import { aboutDiagnosticsText } from './about-diagnostics.js';
import type { AboutUpdateLines } from './about-update-model.js';

const status: AboutUpdateLines = {
  tone: 'current',
  headline: 'Up to date with origin/master',
  rows: [
    { label: 'Running commit', value: 'abcdef1', mono: true },
    { label: 'Committed', value: '2 hours ago' },
    { label: 'Origin', value: '1234567', mono: true },
    { label: 'Last fetch', value: '5 minutes ago' },
    { label: 'Process up', value: '1 day' },
    { label: 'Last update', value: 'updated 3 hours ago · to abcdef1' },
  ],
};

const input = {
  appName: 'Phantom',
  desktopVersion: '3.30.0',
  interfaceVersion: '3.30.0',
  serverVersion: '3.30.0',
  status,
  skew: { text: 'Desktop 3.29.15 is older than Phantom 3.30.0 · install the desktop update when offered' },
  nowIso: '2026-10-31T12:00:00.000Z',
};

describe('aboutDiagnosticsText', () => {
  it('writes one fact per line in the stated order', () => {
    expect(aboutDiagnosticsText(input)).toBe([
      'Phantom diagnostics · 2026-10-31T12:00:00.000Z',
      'Desktop: v3.30.0',
      'Interface: v3.30.0',
      'Server: v3.30.0',
      'Update: Up to date with origin/master',
      'Running commit: abcdef1',
      'Committed: 2 hours ago',
      'Origin: 1234567',
      'Last fetch: 5 minutes ago',
      'Process up: 1 day',
      'Last update: updated 3 hours ago · to abcdef1',
      'Skew: Desktop 3.29.15 is older than Phantom 3.30.0 · install the desktop update when offered',
    ].join('\n'));
  });

  it('uses the stated words when the desktop and server versions are absent', () => {
    const text = aboutDiagnosticsText({ ...input, desktopVersion: null, serverVersion: null });
    expect(text).toContain('Desktop: not a desktop build');
    expect(text).toContain('Server: unknown');
    expect(text).not.toContain('Desktop: v');
    expect(text).not.toContain('Server: v');
  });

  it('leaves the Skew line out when there is no skew note', () => {
    const text = aboutDiagnosticsText({ ...input, skew: null });
    expect(text).not.toContain('Skew:');
    expect(text.split('\n').at(-1)).toBe('Last update: updated 3 hours ago · to abcdef1');
  });

  it('keeps status rows in the order the model produced them', () => {
    const rows = [
      { label: 'Process up', value: '3 minutes' },
      { label: 'Running commit', value: '9999fff', mono: true },
      { label: 'Last fetch', value: 'just now' },
    ];
    const text = aboutDiagnosticsText({ ...input, skew: null, status: { ...status, rows } });
    const lines = text.split('\n');
    const at = (label: string) => lines.findIndex((line) => line.startsWith(`${label}:`));
    expect(at('Process up')).toBeLessThan(at('Running commit'));
    expect(at('Running commit')).toBeLessThan(at('Last fetch'));
  });

  it('carries no paths and no trailing newline', () => {
    const text = aboutDiagnosticsText(input);
    expect(text).not.toContain('/Users');
    expect(text.endsWith('\n')).toBe(false);
  });
});
