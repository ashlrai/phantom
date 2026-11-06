import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeQr } from './qr-encode.js';

// ISO level M format strings, indexed by mask.
const FORMATS = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
const CENTERS = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const masks = [
  (x: number, y: number) => (x + y) % 2 === 0, (_x: number, y: number) => y % 2 === 0,
  (x: number) => x % 3 === 0, (x: number, y: number) => (x + y) % 3 === 0,
  (x: number, y: number) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x: number, y: number) => x * y % 2 + x * y % 3 === 0,
  (x: number, y: number) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x: number, y: number) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];
function formatPositions(): [number, number][] {
  return [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
}
function formatValue(m: boolean[][]): number {
  return formatPositions().reduce((sum, [x, y], i) => sum + Number(m[y][x]) * 2 ** i, 0);
}
function fixed(x: number, y: number, n: number): boolean {
  const version = (n - 17) / 4;
  if ((x < 9 && y < 9) || (x >= n - 8 && y < 9) || (x < 9 && y >= n - 8) || x === 6 || y === 6) return true;
  if (version >= 7 && ((x >= n - 11 && x < n - 8 && y < 6) || (y >= n - 11 && y < n - 8 && x < 6))) return true;
  return CENTERS[version].some(cx => CENTERS[version].some(cy =>
    !(cx === 6 && (cy === 6 || cy === n - 7)) && !(cx === n - 7 && cy === 6) && Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2));
}
function remask(source: boolean[][], target: number): boolean[][] {
  const n = source.length, original = FORMATS.indexOf(formatValue(source));
  expect(original).toBeGreaterThanOrEqual(0);
  const result = source.map((row, y) => row.map((v, x) => fixed(x, y, n) ? v : v !== (masks[original](x, y) !== masks[target](x, y))));
  formatPositions().forEach(([x, y], i) => { result[y][x] = Boolean(FORMATS[target] & (1 << i)); });
  for (let i = 0; i < 8; i++) result[8][n - 1 - i] = Boolean(FORMATS[target] & (1 << i));
  for (let i = 8; i < 15; i++) result[n - 15 + i][8] = Boolean(FORMATS[target] & (1 << i));
  return result;
}
function score(m: boolean[][]): number {
  const n = m.length;
  let result = 0, dark = 0;
  const lines = [...m, ...m.map((_, x) => m.map(row => row[x]))];
  for (const line of lines) {
    const str = line.map(Number).join('');
    for (const match of str.matchAll(/0{5,}|1{5,}/g)) result += match[0].length - 2;
    for (let i = 0; i <= n - 11; i++) if (['10111010000', '00001011101'].includes(str.slice(i, i + 11))) result += 40;
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    dark += Number(m[y][x]);
    if (x + 1 < n && y + 1 < n && [m[y][x + 1], m[y + 1][x], m[y + 1][x + 1]].every(v => v === m[y][x])) result += 3;
  }
  return result + Math.floor(Math.abs(dark / (n * n) * 100 - 50) / 5) * 10;
}
function codewords(m: boolean[][]): number[] {
  const n = m.length, mask = FORMATS.indexOf(formatValue(m));
  const bits: number[] = [];
  for (let x = n - 1; x > 0; x -= 2) {
    if (x === 6) x--;
    for (let i = 0; i < n; i++) for (const col of [x, x - 1]) {
      const y = ((x + 1) & 2) === 0 ? n - 1 - i : i;
      if (!fixed(col, y, n)) bits.push(Number(m[y][col] !== masks[mask](col, y)));
    }
  }
  return Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8).join(''), 2));
}

describe('QR encoding', () => {
  it('places the byte-mode HELLO WORLD data and degree-10 Reed–Solomon reference', () => {
    const words = codewords(encodeQr('HELLO WORLD').modules);
    expect(words.slice(0, 16)).toEqual([64, 180, 132, 84, 196, 196, 242, 5, 116, 245, 36, 196, 64, 236, 17, 236]);
    expect(words.slice(16)).toEqual([12, 75, 207, 154, 137, 79, 101, 9, 151, 204]);
  });
  it('places finder and timing patterns and both format copies', () => {
    const { size: n, modules: m } = encodeQr('https://example.cloudflareaccess.com/verse/m');
    for (const [left, top] of [[0, 0], [n - 7, 0], [0, n - 7]]) for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      expect(m[top + y][left + x]).toBe(x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
    }
    for (let i = 8; i < n - 8; i++) { expect(m[6][i]).toBe(i % 2 === 0); expect(m[i][6]).toBe(i % 2 === 0); }
    expect(createHash('sha256').update(remask(m, 0).flat().map(Number).join('')).digest('hex')).toBe('a30c27ae8e9bbe101cb4a07fdca86cca0ae457214a5d60e277665c3df4459aa3');
    const value = formatValue(m);
    expect(FORMATS).toContain(value);
    for (let i = 0; i < 8; i++) expect(m[8][n - 1 - i]).toBe(Boolean(value & (1 << i)));
    for (let i = 8; i < 15; i++) expect(m[n - 15 + i][8]).toBe(Boolean(value & (1 << i)));
  });
  it.each([1, 15, 27, 43, 63, 85, 107, 123, 153, 181])('matches the reference and chooses the lowest penalty for %i bytes', (length) => {
    // SHA-256 of mask-0 matrices from Python qrcode, forced byte mode and level M.
    const hashes = ['8ac8f40772e90e7a9fa290ea15bc45c68c2184a9c85450eac32a0bd7fd07ed4a', '6ced886ceba6a2cd9bb11a90796a1abd3192bfe436f65c28d440f1f5ba371517', '6e7dc8b0b6e52abf2ab56413c00d327ea2759966c6246ca816ed2daf5651c5e2', '3a7a351ad911dd570986a8b0807d2f1186f316bb242933915c6ee259e5216d0a', '905535d6d9c24336399f96c3f117bfce25fbb693277def161b3f16a1ba5d0309', '093a3c4e554acf9868933fe500bcb17f14c4ac237f6e23482e049aa581bf66f5', '944b1b50543e0e2611cb2013a580d83f7c08329e205f776351c5203c485b25cd', '8b0bdaa877d87c0bb9e97cc32f13da5c5425bd578f050fb794cd6870f165201a', 'd4e908831c86c849c0ead7fe8103fbb749b78a96767cda6ecf7f411f0ad2a3ba', '45abd513b9c935999dc62d9b237e494708a6a21e5594c8b396516ebbaafecaaa'];
    const index = [1, 15, 27, 43, 63, 85, 107, 123, 153, 181].indexOf(length);
    {
      const { size, modules } = encodeQr('a'.repeat(length));
      expect(size).toBe(17 + 4 * (index + 1));
      expect(modules.every(row => row.length === size)).toBe(true);
      const normalized = remask(modules, 0).flat().map(Number).join('');
      expect(createHash('sha256').update(normalized).digest('hex')).toBe(hashes[index]);
      const scores = masks.map((_, mask) => score(remask(modules, mask)));
      expect(FORMATS.indexOf(formatValue(modules))).toBe(scores.indexOf(Math.min(...scores)));
    }
  });
  it('enforces the UTF-8 byte capacity', () => {
    expect(encodeQr('a'.repeat(213)).size).toBe(57);
    expect(() => encodeQr('a'.repeat(214))).toThrow(Error);
    expect(encodeQr('é'.repeat(7)).size).toBe(21);
    expect(encodeQr('é'.repeat(8)).size).toBe(25);
  });
});
