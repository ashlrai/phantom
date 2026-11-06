// QR Model 2, level M: data codewords per block and EC codewords per block.
const BLOCKS = [[], [16], [28], [44], [32, 32], [43, 43], [27, 27, 27, 27],
  [31, 31, 31, 31], [38, 38, 39, 39], [36, 36, 36, 37, 37], [43, 43, 43, 43, 44]];
const EC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function multiply(a: number, b: number): number {
  let result = 0;
  for (let i = 7; i >= 0; i--) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((b >>> i) & 1) * a;
  }
  return result;
}

function errorCorrection(data: number[], degree: number): number[] {
  let generator = [1];
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const next = Array<number>(generator.length + 1).fill(0);
    generator.forEach((value, j) => { next[j] ^= value; next[j + 1] ^= multiply(value, root); });
    generator = next;
    root = multiply(root, 2);
  }
  const remainder = Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    for (let i = 0; i < degree; i++) remainder[i] ^= multiply(generator[i + 1], factor);
  }
  return remainder;
}

function maskBit(mask: number, x: number, y: number): boolean {
  const p = x * y;
  return [((x + y) % 2), y % 2, x % 3, (x + y) % 3,
    (Math.floor(y / 2) + Math.floor(x / 3)) % 2, p % 2 + p % 3,
    (p % 2 + p % 3) % 2, ((x + y) % 2 + p % 3) % 2][mask] === 0;
}

function penalty(matrix: boolean[][]): number {
  const n = matrix.length;
  let score = 0;
  for (let axis = 0; axis < 2; axis++) for (let a = 0; a < n; a++) {
    const line = Array.from({ length: n }, (_, b) => axis ? matrix[b][a] : matrix[a][b]);
    let run = 1;
    for (let i = 1; i < n; i++) {
      run = line[i] === line[i - 1] ? run + 1 : 1;
      if (run === 5) score += 3;
      else if (run > 5) score++;
    }
    for (let i = 0; i <= n - 11; i++) {
      const bits = line.slice(i, i + 11).map(Number).join('');
      if (bits === '00001011101' || bits === '10111010000') score += 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (matrix[y][x]) dark++;
    if (x && y && matrix[y][x] === matrix[y - 1][x] && matrix[y][x] === matrix[y][x - 1] && matrix[y][x] === matrix[y - 1][x - 1]) score += 3;
  }
  return score + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
}

export function encodeQr(text: string): { size: number; modules: boolean[][] } {
  const bytes = [...new TextEncoder().encode(text)];
  const version = BLOCKS.findIndex((blocks, v) => v > 0 && 4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= blocks.reduce((a, b) => a + b, 0) * 8);
  if (version < 0) throw new Error('Text is too long for a QR code');
  const capacity = BLOCKS[version].reduce((a, b) => a + b, 0) * 8;
  const bits: number[] = [];
  const append = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  append(4, 4); append(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach(byte => append(byte, 8));
  append(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let i = 0; data.length * 8 < capacity; i++) data.push(i % 2 ? 0x11 : 0xec);
  let offset = 0;
  const blocks = BLOCKS[version].map(length => { const block = data.slice(offset, offset + length); offset += length; return block; });
  const checks = blocks.map(block => errorCorrection(block, EC[version]));
  const codewords: number[] = [];
  for (let i = 0; i < Math.max(...BLOCKS[version]); i++) for (const block of blocks) if (i < block.length) codewords.push(block[i]);
  for (let i = 0; i < EC[version]; i++) for (const block of checks) codewords.push(block[i]);

  const size = 17 + version * 4;
  const base = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const reserved = base.map(row => row.slice());
  const set = (x: number, y: number, dark: boolean) => { if (x >= 0 && y >= 0 && x < size && y < size) { base[y][x] = dark; reserved[y][x] = true; } };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4);
    }
  }
  for (const y of ALIGN[version]) for (const x of ALIGN[version]) {
    if ((x === 6 && (y === 6 || y === size - 7)) || (x === size - 7 && y === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = (matrix: boolean[][], mask: number) => {
    let rem = mask;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const value = ((mask << 10) | rem) ^ 0x5412;
    const put = (x: number, y: number, i: number) => { matrix[y][x] = ((value >>> i) & 1) !== 0; reserved[y][x] = true; };
    for (let i = 0; i <= 5; i++) put(8, i, i);
    put(8, 7, 6); put(8, 8, 7); put(7, 8, 8);
    for (let i = 9; i < 15; i++) put(14 - i, 8, i);
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, i);
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, i);
    matrix[size - 8][8] = true; reserved[size - 8][8] = true;
  };
  format(base, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const value = (version << 12) | rem;
    for (let i = 0; i < 18; i++) { const bit = ((value >>> i) & 1) !== 0; const a = size - 11 + i % 3; const b = Math.floor(i / 3); set(a, b, bit); set(b, a, bit); }
  }
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!reserved[y][x]) { base[y][x] = bit < codewords.length * 8 && ((codewords[bit >>> 3] >>> (7 - bit % 8)) & 1) !== 0; bit++; }
    }
  }
  let best = base, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.map((row, y) => row.map((value, x) => reserved[y][x] ? value : value !== maskBit(mask, x, y)));
    format(candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  return { size, modules: best };
}
