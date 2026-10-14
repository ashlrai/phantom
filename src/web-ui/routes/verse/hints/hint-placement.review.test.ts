import { describe, expect, it } from 'vitest';
import { placeHintBadges } from './hint-placement.js';

type Box = { left: number; top: number; width: number; height: number };
type Badge = Box & { id: string };
const intersects = (a: Box, b: Box) => Math.max(a.left, b.left) < Math.min(a.left + a.width, b.left + b.width) && Math.max(a.top, b.top) < Math.min(a.top + a.height, b.top + b.height);

function expectReadable(measured: Badge[], viewport: { width: number; height: number }, reserved: Box[]) {
  const placed = placeHintBadges(measured, viewport, reserved);
  expect(placed).not.toBeNull();
  expect(placed!.map(box => box.id).sort()).toEqual(measured.map(box => box.id).sort());
  placed!.forEach((box, index) => {
    expect(box.left).toBeGreaterThanOrEqual(0); expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.left + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.top + box.height).toBeLessThanOrEqual(viewport.height);
    expect(reserved.some(other => intersects(box, other))).toBe(false);
    expect(placed!.slice(index + 1).some(other => intersects(box, other))).toBe(false);
    const original = measured.find(other => other.id === box.id)!;
    expect(box.width).toBe(original.width); expect(box.height).toBe(original.height);
  });
  expect(placeHintBadges(measured, viewport, reserved)).toEqual(placed);
}

describe('independent measured hint placement review', () => {
  it('keeps the actual right/bottom edge badge sizes inside the desktop viewport', () => {
    expectReadable([
      { id: 'right', left: 1900, top: 459.828125, width: 26.453125, height: 20 },
      { id: 'bottom', left: 883.1875, top: 942, width: 26.453125, height: 20 },
    ], { width: 1920, height: 958 }, [{ left: 837.921875, top: 904, width: 244.15625, height: 34 }]);
  });
  it.each([
    { scale: '100%', width: 26.453125, height: 20, statusTop: 730 },
    { scale: '150%', width: 33.6875, height: 28, statusTop: 690 },
  ])('separates measured 17px-spaced labels and reserves the visible status at $scale', ({ width, height, statusTop }) => {
    const measured = Array.from({ length: 8 }, (_, index) => ({ id: `stack.${index}`, left: 12, top: 450 + index * 17, width, height }));
    measured.push({ id: 'right', left: 300, top: 384, width, height }, { id: 'bottom', left: 147.1875, top: 784, width, height });
    expectReadable(measured, { width: 320, height: 800 }, [{ left: 80, top: statusTop, width: 160, height: 780 - statusTop }]);
  });
  it('places a complete maximum-size inventory without discarding or shrinking labels', () => {
    const measured = Array.from({ length: 200 }, (_, index) => ({ id: `fixture.${index}`, left: (index % 20) * 30, top: Math.floor(index / 20) * 30, width: 16, height: 16 }));
    expectReadable(measured, { width: 640, height: 480 }, [{ left: 200, top: 430, width: 240, height: 40 }]);
  });
  it('keeps dense control labels on their target rows when horizontal space is available', () => {
    const measured = Array.from({ length: 8 }, (_, index) => ({ id: `row.${index}`, left: 12, top: 450 + index * 17, width: 33.6875, height: 28 }));
    const placed = placeHintBadges(measured, { width: 320, height: 800 }, [{ left: 80, top: 690, width: 160, height: 90 }]);
    expect(placed).not.toBeNull();
    // A label shifted onto a neighboring row can visually identify the wrong
    // control even if its own rectangle no longer overlaps another label.
    expect(placed!.map(box => box.top)).toEqual(measured.map(box => box.top));
    expectReadable(measured, { width: 320, height: 800 }, [{ left: 80, top: 690, width: 160, height: 90 }]);
  });
  it('refuses a label or reserved status that cannot fit instead of hiding part of it', () => {
    const badge = { id: 'one', left: 0, top: 0, width: 41, height: 20 };
    expect(placeHintBadges([badge], { width: 40, height: 20 }, [])).toBeNull();
    expect(placeHintBadges([{ ...badge, width: 40 }], { width: 40, height: 20 }, [{ left: 0, top: 0, width: 40, height: 20 }])).toBeNull();
  });
  it.each([
    { left: Number.NaN, top: 0, width: 20, height: 20 },
    { left: 0, top: Number.POSITIVE_INFINITY, width: 20, height: 20 },
    { left: 0, top: 0, width: 0, height: 20 },
    { left: 0, top: 0, width: 20, height: -1 },
  ])('rejects malformed measured geometry %#', (box) => {
    expect(placeHintBadges([{ id: 'bad', ...box }], { width: 320, height: 800 }, [])).toBeNull();
  });
  it('refuses an inventory beyond the discovery bound', () => {
    const measured = Array.from({ length: 201 }, (_, index) => ({ id: `fixture.${index}`, left: 0, top: 0, width: 10, height: 10 }));
    expect(placeHintBadges(measured, { width: 1920, height: 1080 }, [])).toBeNull();
  });
  it('rejects ambiguous or empty identities rather than merging visible labels', () => {
    const box = { id: 'same', left: 0, top: 0, width: 20, height: 20 };
    expect(placeHintBadges([box, { ...box, left: 40 }], { width: 320, height: 800 }, [])).toBeNull();
    expect(placeHintBadges([{ ...box, id: '' }], { width: 320, height: 800 }, [])).toBeNull();
  });
  it('preserves recorded insertion order when left/right candidates have equal priority', () => {
    const measured = Array.from({ length: 4 }, (_, index) => ({ id: String(index), left: 100, top: 50, width: 50, height: 20 }));
    // Recorded with the original stable-sort queue before its optimization.
    // A heap without an insertion-sequence tiebreaker can silently swap sides.
    expect(placeHintBadges(measured, { width: 400, height: 300 }, [])).toEqual([
      { ...measured[0], left: 100 }, { ...measured[1], left: 152 },
      { ...measured[2], left: 48 }, { ...measured[3], left: 204 },
    ]);
  });
  it('preserves the first inserted side for a symmetric reserved obstacle', () => {
    const badge = { id: 'one', left: 100, top: 50, width: 50, height: 20 };
    expect(placeHintBadges([badge], { width: 400, height: 300 }, [{ left: 100, top: 50, width: 50, height: 20 }])).toEqual([{ ...badge, left: 152 }]);
  });
});
