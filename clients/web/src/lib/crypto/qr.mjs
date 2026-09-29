/** A QR encoder, byte mode, error-correction level M, versions 1 to 10.
 *
 * Here so a safety number can be compared by scanning rather than read aloud
 * digit by digit. Sixty digits read over a phone call is where verification
 * stops happening, and a verification step people skip protects nobody.
 *
 * Written out rather than added as a dependency: this app ships four runtime
 * packages on purpose, and a key-verification path is the last place to widen
 * the supply chain. The format is fully specified (ISO/IEC 18004) and the
 * suite decodes what this produces with OpenCV, so it is checked against an
 * independent reader rather than against itself.
 *
 * Scope is deliberately narrow. Byte mode only, level M only, ten versions:
 * enough for a safety number several times over, and every table below is one
 * that has to be right.
 */

const EC_LEVEL_M = 0;

/** Per version (index 0 is version 1): error-correction codewords per block,
 * then the block groups as [count, dataCodewords]. ISO/IEC 18004 Table 9. */
const BLOCKS_M = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];

/** Centres of the alignment patterns, per version. */
const ALIGNMENT = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Pre-computed 18-bit version information, versions 7 to 10. Below 7 the
 * field is absent from the symbol entirely. */
const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

// --- GF(256), the field Reed-Solomon works in ------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    // 0x11d is the primitive polynomial QR specifies.
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function eccFor(data, count) {
  const gen = generatorPoly(count);
  const remainder = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < count; i += 1) remainder[i] ^= gfMul(gen[i + 1], factor);
  }
  return remainder;
}

// --- bit stream ------------------------------------------------------

class Bits {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
  toBytes() {
    const bytes = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      bytes.push(byte);
    }
    return bytes;
  }
}

function dataCapacity(version) {
  return BLOCKS_M[version - 1].groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

function chooseVersion(byteLength) {
  for (let version = 1; version <= 10; version += 1) {
    // 4 bits mode + count field + payload, rounded up to whole codewords.
    const countBits = version < 10 ? 8 : 16;
    const needed = Math.ceil((4 + countBits + byteLength * 8) / 8);
    if (needed <= dataCapacity(version)) return version;
  }
  throw new Error("payload too large for a version-10 QR at level M");
}

function encodeData(bytes, version) {
  const capacity = dataCapacity(version);
  const stream = new Bits();
  stream.push(0b0100, 4); // byte mode
  stream.push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) stream.push(byte, 8);

  // Terminator, up to four zero bits, then pad to a byte boundary.
  const remaining = capacity * 8 - stream.length;
  stream.push(0, Math.min(4, remaining));
  while (stream.length % 8 !== 0) stream.push(0, 1);

  const out = stream.toBytes();
  // The two pad codewords the spec names, alternating.
  const PAD = [0xec, 0x11];
  for (let i = 0; out.length < capacity; i += 1) out.push(PAD[i % 2]);
  return out;
}

/** Splits into blocks, computes ECC per block, then interleaves -- which is
 * what makes a scratch across the symbol damage a little of every block
 * rather than destroying one outright. */
function interleave(data, version) {
  const { ec, groups } = BLOCKS_M[version - 1];
  const blocks = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i += 1) {
      const chunk = data.slice(at, at + size);
      at += size;
      blocks.push({ data: chunk, ecc: eccFor(chunk, ec) });
    }
  }

  const out = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < ec; i += 1) {
    for (const block of blocks) out.push(block.ecc[i]);
  }
  return out;
}

// --- the matrix ------------------------------------------------------

function sizeFor(version) {
  return version * 4 + 17;
}

function blankMatrix(version) {
  const size = sizeFor(version);
  return {
    size,
    // null means "not yet written", which is what keeps data placement from
    // overwriting a function pattern.
    cells: Array.from({ length: size }, () => new Array(size).fill(null)),
    reserved: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}

function place(m, x, y, value, reserve = true) {
  if (x < 0 || y < 0 || x >= m.size || y >= m.size) return;
  m.cells[y][x] = value;
  if (reserve) m.reserved[y][x] = true;
}

function drawFinder(m, x, y) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark =
        inRing &&
        ((dx === 0 || dx === 6 || dy === 0 || dy === 6) ||
          (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      // The separator is the -1/7 ring: always light, always reserved.
      place(m, x + dx, y + dy, dark ? 1 : 0);
    }
  }
}

function drawAlignment(m, version) {
  const centres = ALIGNMENT[version - 1];
  for (const cy of centres) {
    for (const cx of centres) {
      // Skipped where a finder already is.
      const nearFinder =
        (cx <= 8 && cy <= 8) ||
        (cx <= 8 && cy >= m.size - 9) ||
        (cx >= m.size - 9 && cy <= 8);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          place(m, cx + dx, cy + dy, dark ? 1 : 0);
        }
      }
    }
  }
}

function drawTiming(m) {
  for (let i = 8; i < m.size - 8; i += 1) {
    const dark = i % 2 === 0 ? 1 : 0;
    place(m, i, 6, dark);
    place(m, 6, i, dark);
  }
}

function reserveFormat(m) {
  for (let i = 0; i < 9; i += 1) {
    if (m.cells[8][i] === null) place(m, i, 8, 0);
    if (m.cells[i][8] === null) place(m, 8, i, 0);
  }
  for (let i = 0; i < 8; i += 1) {
    place(m, m.size - 1 - i, 8, 0);
    place(m, 8, m.size - 1 - i, 0);
  }
  // The one module that is always dark, immediately above the lower-left
  // finder's format strip.
  place(m, 8, m.size - 8, 1);
}

function drawVersionInfo(m, version) {
  const info = VERSION_INFO[version];
  if (!info) return;
  for (let i = 0; i < 18; i += 1) {
    const bit = (info >> i) & 1;
    const x = Math.floor(i / 3);
    const y = m.size - 11 + (i % 3);
    place(m, x, y, bit);
    place(m, y, x, bit);
  }
}

function placeData(m, codewords) {
  let bitIndex = 0;
  const total = codewords.length * 8;
  let upward = true;

  for (let right = m.size - 1; right > 0; right -= 2) {
    // Column 6 is the vertical timing pattern; the pairing skips over it.
    if (right === 6) right = 5;
    for (let step = 0; step < m.size; step += 1) {
      const y = upward ? m.size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (m.reserved[y][x]) continue;
        let bit = 0;
        if (bitIndex < total) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
        }
        bitIndex += 1;
        m.cells[y][x] = bit;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, maskIndex) {
  const out = {
    size: m.size,
    cells: m.cells.map((row) => row.slice()),
    reserved: m.reserved,
  };
  for (let y = 0; y < m.size; y += 1) {
    for (let x = 0; x < m.size; x += 1) {
      if (m.reserved[y][x]) continue;
      if (MASKS[maskIndex](x, y)) out.cells[y][x] ^= 1;
    }
  }
  return out;
}

/** BCH(15,5) format information, XORed with the spec's 0x5412 so an all-zero
 * format never produces an all-light strip. */
export function formatBits(ecLevel, maskIndex) {
  const data = (ecLevel << 3) | maskIndex;
  let value = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((value >> (i + 10)) & 1) value ^= 0x537 << i;
  }
  return ((data << 10) | value) ^ 0x5412;
}

function drawFormat(m, maskIndex) {
  const bits = formatBits(EC_LEVEL_M, maskIndex);
  for (let i = 0; i < 15; i += 1) {
    const bit = (bits >> i) & 1;
    // The two copies, placed the way the spec lays them out.
    if (i < 6) place(m, 8, i, bit);
    else if (i === 6) place(m, 8, 7, bit);
    else if (i === 7) place(m, 8, 8, bit);
    else if (i === 8) place(m, 7, 8, bit);
    else place(m, 14 - i, 8, bit);

    if (i < 8) place(m, m.size - 1 - i, 8, bit);
    else place(m, 8, m.size - 15 + i, bit);
  }
}

/** The four penalty rules. Picking the lowest-scoring mask is what stops a
 * symbol containing large blank runs or finder-lookalikes that confuse a
 * scanner. */
function penalty(m) {
  const { size, cells } = m;
  let score = 0;

  const runPenalty = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === line[i - 1]) run += 1;
      else {
        if (run >= 5) total += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };

  for (let i = 0; i < size; i += 1) {
    score += runPenalty(cells[i]);
    score += runPenalty(cells.map((row) => row[i]));
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const v = cells[y][x];
      if (v === cells[y][x + 1] && v === cells[y + 1][x] && v === cells[y + 1][x + 1]) score += 3;
    }
  }

  const FINDER = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const REVERSED = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, at, pattern) => pattern.every((v, i) => line[at + i] === v);
  for (let i = 0; i < size; i += 1) {
    const row = cells[i];
    const col = cells.map((r) => r[i]);
    for (let j = 0; j + 11 <= size; j += 1) {
      if (matches(row, j, FINDER) || matches(row, j, REVERSED)) score += 40;
      if (matches(col, j, FINDER) || matches(col, j, REVERSED)) score += 40;
    }
  }

  let dark = 0;
  for (const row of cells) for (const v of row) dark += v;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** Encodes `text` and returns the module matrix: `matrix[y][x]`, 1 for dark. */
export function encodeQr(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = chooseVersion(bytes.length);
  const codewords = interleave(encodeData(bytes, version), version);

  const base = blankMatrix(version);
  drawFinder(base, 0, 0);
  drawFinder(base, base.size - 7, 0);
  drawFinder(base, 0, base.size - 7);
  drawAlignment(base, version);
  drawTiming(base);
  reserveFormat(base);
  drawVersionInfo(base, version);
  placeData(base, codewords);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(base, mask);
    drawFormat(candidate, mask);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, mask, matrix: candidate.cells };
  }
  return { version, mask: best.mask, size: base.size, matrix: best.matrix };
}

/** The symbol as an SVG path, at one unit per module. The caller sets the
 * viewBox and the quiet zone, which the spec requires to be four modules --
 * a QR rendered flush against a coloured background often will not scan. */
export function qrPath(matrix) {
  const parts = [];
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix[y].length; x += 1) {
      if (matrix[y][x]) parts.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return parts.join("");
}

export const QUIET_ZONE = 4;
