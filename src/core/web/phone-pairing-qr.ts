/**
 * One-time phone pairing payload and a QR of that payload.
 * The code sits in the URL fragment, so a scan does not send it to the server.
 * An expired code produces nothing.
 */
const PAIR_CODE = /^[A-Za-z0-9_-]{43}$/;
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

const VERSIONS: Array<{ data: number; ec: number; align: number[]; remainder: number } | null> = [
  null,
  { data: 19, ec: 7, align: [], remainder: 0 },
  { data: 34, ec: 10, align: [6, 18], remainder: 7 },
  { data: 55, ec: 15, align: [6, 22], remainder: 7 },
  { data: 80, ec: 20, align: [6, 26], remainder: 7 },
  { data: 108, ec: 26, align: [6, 30], remainder: 7 },
];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

function rsRemainder(data: number[], ecLen: number): number[] {
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] = (next[j] ?? 0) ^ gen[j]!;
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(gen[j]!, EXP[i]!);
    }
    gen = next;
  }
  const ecc = new Array<number>(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ ecc[0]!;
    ecc.copyWithin(0, 1);
    ecc[ecLen - 1] = 0;
    if (factor !== 0) for (let i = 0; i < ecLen; i++) ecc[i] = (ecc[i] ?? 0) ^ mul(gen[i + 1]!, factor);
  }
  return ecc;
}

/** Format bits for ECC level L and mask 0. The known value is 0b111011111000100. */
export function phoneQrFormatBits(): number {
  const data = 0b01000;
  let bits = data << 10;
  const generator = 0b10100110111;
  for (let i = 4; i >= 0; i--) if ((bits >>> (i + 10)) & 1) bits ^= generator << i;
  return ((data << 10) | (bits & 0x3ff)) ^ 0x5412;
}

function dataCodewords(bytes: Uint8Array, version: number): number[] | null {
  const spec = VERSIONS[version];
  if (!spec) return null;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  const capacity = spec.data * 8;
  if (bits.length > capacity) return null;
  for (let i = 0; i < Math.min(4, capacity - bits.length); i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  if (bits.length / 8 > spec.data) return null;
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b]!;
    out.push(byte);
  }
  for (let pad = 0; out.length < spec.data; pad++) out.push(pad % 2 === 0 ? 0xec : 0x11);
  return out;
}

function chooseVersion(bytes: Uint8Array): number | null {
  for (let version = 1; version < VERSIONS.length; version++) if (dataCodewords(bytes, version)) return version;
  return null;
}

function qrMatrix(bytes: Uint8Array): number[][] | null {
  const version = chooseVersion(bytes);
  const spec = version ? VERSIONS[version] : null;
  const data = version ? dataCodewords(bytes, version) : null;
  if (!version || !spec || !data) return null;
  const codewords = data.concat(rsRemainder(data, spec.ec));
  const size = 17 + 4 * version;
  const matrix = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (row: number, col: number, on: boolean) => {
    matrix[row]![col] = on ? 1 : 0;
    reserved[row]![col] = true;
  };
  const finder = (top: number, left: number) => {
    for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) {
      const row = top + y;
      const col = left + x;
      if (row < 0 || col < 0 || row >= size || col >= size) continue;
      const inside = x >= 0 && x <= 6 && y >= 0 && y <= 6;
      const edge = x === 0 || x === 6 || y === 0 || y === 6;
      const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      mark(row, col, inside && (edge || core));
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 0; i < size; i++) {
    if (!reserved[6]![i]) mark(6, i, i % 2 === 0);
    if (!reserved[i]![6]) mark(i, 6, i % 2 === 0);
  }
  const finderOrigins: Array<[number, number]> = [[0, 0], [0, size - 7], [size - 7, 0]];
  const overlapsFinder = (row: number, col: number) => finderOrigins
    .some(([top, left]) => row >= top - 2 && row <= top + 8 && col >= left - 2 && col <= left + 8);
  for (const row of spec.align) for (const col of spec.align) {
    if (overlapsFinder(row, col)) continue;
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      mark(row + y, col + x, Math.max(Math.abs(x), Math.abs(y)) !== 1);
    }
  }
  mark(size - 8, 8, true);
  const formatPositions: Array<[number, number]> = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (const [row, col] of formatPositions) reserved[row]![col] = true;
  for (let i = 0; i < 8; i++) reserved[8]![size - 1 - i] = true;
  for (let i = 0; i < 7; i++) reserved[size - 7 + i]![8] = true;
  const bits: number[] = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
  let free = 0;
  for (const row of reserved) for (const cell of row) if (!cell) free++;
  if (free !== bits.length + spec.remainder) return null;
  let cursor = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const x of [col, col - 1]) {
        if (x < 0 || reserved[row]![x]) continue;
        const bit = cursor < bits.length ? bits[cursor]! : 0;
        cursor++;
        matrix[row]![x] = (row + x) % 2 === 0 ? bit ^ 1 : bit;
      }
    }
    upward = !upward;
  }
  if (cursor !== bits.length + spec.remainder) return null;
  const format = phoneQrFormatBits();
  for (let i = 0; i < 15; i++) {
    const on = ((format >>> (14 - i)) & 1) === 1;
    const [row, col] = formatPositions[i]!;
    matrix[row]![col] = on ? 1 : 0;
  }
  for (let i = 0; i < 8; i++) matrix[8]![size - 1 - i] = ((format >>> (14 - i)) & 1);
  for (let i = 0; i < 7; i++) matrix[size - 7 + i]![8] = (format >>> (6 - i)) & 1;
  return matrix;
}

export function phonePairingPayload(origin: string, code: string, expiresAt: number, now: number): string | null {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now) || expiresAt <= now) return null;
  if (!ORIGIN.test(origin) || !PAIR_CODE.test(code)) return null;
  return `${origin}/verse/m/#/pair/${code}`;
}

function svgOf(matrix: number[][]): string {
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  const cells: string[] = [];
  matrix.forEach((row, y) => row.forEach((cell, x) => {
    if (cell) cells.push(`<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1"/>`);
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>${cells.join('')}</svg>`;
}

function asciiOf(matrix: number[][]): string {
  const quiet = 2;
  const dark = '██';
  const light = '  ';
  const line = dark.repeat(matrix.length + quiet * 2);
  const rows = [line];
  for (let i = 0; i < quiet - 1; i++) rows.push(line);
  for (const row of matrix) {
    rows.push(`${dark.repeat(quiet)}${row.map((cell) => cell ? dark : light).join('')}${dark.repeat(quiet)}`);
  }
  rows.push(line, line);
  return rows.join('\n');
}

export function phonePairingQr(origin: string, code: string, expiresAt: number, now: number): { payload: string; svg: string; ascii: string } | null {
  const payload = phonePairingPayload(origin, code, expiresAt, now);
  if (!payload) return null;
  const matrix = qrMatrix(new TextEncoder().encode(payload));
  if (!matrix) return null;
  return { payload, svg: svgOf(matrix), ascii: asciiOf(matrix) };
}
