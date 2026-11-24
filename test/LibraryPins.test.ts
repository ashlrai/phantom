import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pane = readFileSync(new URL('../src/web-ui/routes/verse/library/LibraryPane.tsx', import.meta.url), 'utf8');
const pins = readFileSync(new URL('../src/web-ui/routes/verse/library/LibraryPins.tsx', import.meta.url), 'utf8');

describe('library pin pane wiring', () => {
  it('posts pins to the verse library pins route', () => {
    expect(pins).toContain("export const LIBRARY_PINS_PATH = '/api/verse/library/pins'");
    expect(pins).toContain('apiPost<PinsResponse>(LIBRARY_PINS_PATH, body, token)');
    expect(pins).toContain('export function PinToggle');
    expect(pins).toContain('export function PinnedGroup');
  });

  it('offers a pin toggle on memory and bus rows and a pinned group', () => {
    expect(pane).toContain("import { PinnedGroup, PinToggle } from './LibraryPins.js'");
    expect(pane).toContain('<PinToggle kind="memory"');
    expect(pane).toContain('<PinToggle kind="bus"');
    expect(pane).toContain('<PinnedGroup visible={visible} />');
  });
});
