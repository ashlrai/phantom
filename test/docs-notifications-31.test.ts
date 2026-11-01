import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DERIVE_FILES = [
  'src/web-ui/components/notifications/deriveNotifications.ts',
  'src/web-ui/components/notifications/deriveFleetRunsNotifications.ts',
  'src/web-ui/components/notifications/deriveFleetLedgerNotifications.ts',
  'src/web-ui/components/notifications/deriveFleetMergeNotifications.ts',
  'src/web-ui/components/notifications/deriveReleasePrNotifications.ts',
  'src/web-ui/components/notifications/deriveUpdateNotifications.ts',
];

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('docs/NOTIFICATIONS.md notification coverage', () => {
  it('page exists and contains a table of severity levels', () => {
    const content = read('docs/NOTIFICATIONS.md');
    expect(content.length).toBeGreaterThan(50);
    expect(content).toContain('Severity');
    expect(content).toContain('When it fires');
  });

  it('every id prefix in the table appears in at least one derive file', () => {
    const doc = read('docs/NOTIFICATIONS.md');

    // Extract every |Id prefix| cell from the table rows.
    const prefixes = [...doc.matchAll(/\|\s*\d+\s*\|\s*(`[^`]+`)/g)].map(
      (m) => m[1]!.replace(/`/g, ''),
    );
    expect(prefixes.length).toBeGreaterThan(0);

    // Each prefix must appear in the source as a string literal.
    for (const prefix of prefixes) {
      const staticPart = prefix.endsWith('*')
        ? prefix.slice(0, -1)
        : prefix;

      // Check whether the static part (or the full id for static entries)
      // appears in any of the derive source files as a string literal.
      const found = DERIVE_FILES.some((f) => {
        const src = read(f);
        // Static id: single-quoted or template-literal form.
        if (staticPart === prefix) {
          return (
            src.includes("'" + prefix + "'") ||
            src.includes('\`' + prefix + '\`')
          );
        }
        // Dynamic id: the prefix stem starts a template literal.
        return src.includes('\`' + staticPart);
      });
      expect(
        found,
        `Prefix "${prefix}" from NOTIFICATIONS.md table must occur in one of the six derive files`,
      ).toBe(true);
    }
  });
});
