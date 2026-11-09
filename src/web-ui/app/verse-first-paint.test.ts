/**
 * app/verse-first-paint.test.ts — the signed-in shell waits for its opening
 * section and the chat's columns, never longer than its bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({
  section: vi.fn<(id: string) => Promise<unknown>>(),
  chatSurface: vi.fn<() => Promise<unknown>>(),
  warm: vi.fn<() => void>(),
}));
vi.mock('../routes/verse/VerseApp.js', () => ({
  loadSection: loads.section,
  SECTION_MODULES: {
    './sections/ChatSection.tsx': async () => ({ preloadChatSurface: loads.chatSurface }),
    './sections/LiveStatusSection.tsx': async () => ({ warmOpeningData: loads.warm }),
    './sections/FleetSection.tsx': async () => ({}),
    './sections/GrowthSection.tsx': async () => { throw new Error('offline'); },
  },
}));

import { firstPaintSurface, warmOpeningSection } from './verse-first-paint.js';
import { resetVerseUi, setVerseSection } from '../routes/verse/verse-ui-store.js';

beforeEach(() => setVerseSection('chat'));

afterEach(() => {
  vi.useRealTimers();
  resetVerseUi();
  loads.section.mockReset();
  loads.chatSurface.mockReset();
  loads.warm.mockReset();
});

describe('firstPaintSurface', () => {
  it('resolves once the Chat section and its list and workspace chunks are in', async () => {
    let finishSurface!: () => void;
    loads.section.mockResolvedValue({});
    loads.chatSurface.mockReturnValue(new Promise<void>((resolve) => { finishSurface = resolve; }));
    let done = false;
    const wait = firstPaintSurface(60_000).then(() => { done = true; });
    await vi.waitFor(() => expect(loads.chatSurface).toHaveBeenCalled());
    expect(loads.section).toHaveBeenCalledWith('chat');
    expect(done).toBe(false);
    finishSurface();
    await wait;
    expect(done).toBe(true);
  });

  it('gives up waiting at its bound, so a slow chunk shows skeletons instead of nothing', async () => {
    vi.useFakeTimers();
    loads.section.mockReturnValue(new Promise(() => {}));
    loads.chatSurface.mockReturnValue(new Promise(() => {}));
    let done = false;
    const wait = firstPaintSurface(500).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(done).toBe(true);
  });

  it('never rejects when a chunk fails to load', async () => {
    loads.section.mockRejectedValue(new Error('offline'));
    loads.chatSurface.mockRejectedValue(new Error('offline'));
    await expect(firstPaintSurface(60_000)).resolves.toBeUndefined();
  });
});

describe('warmOpeningSection', () => {
  it('starts the opening section\'s reads once, through that section\'s own hook', async () => {
    setVerseSection('live');
    await warmOpeningSection();
    expect(loads.warm).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a section that has no hook, and never rejects when its chunk fails', async () => {
    setVerseSection('fleet');
    await expect(warmOpeningSection()).resolves.toBeUndefined();
    setVerseSection('growth');
    await expect(warmOpeningSection()).resolves.toBeUndefined();
    expect(loads.warm).not.toHaveBeenCalled();
  });
});
