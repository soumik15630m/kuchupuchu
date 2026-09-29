/** A minimal ZIP writer, stored (uncompressed) entries only.
 *
 * Exists so "export this chat with its photos" produces something a person
 * can actually open, rather than another container only this app understands.
 * The backup archive is not that -- it is encrypted and versioned for
 * restore, which is a different job from handing someone a folder.
 *
 * Stored rather than deflated on purpose: the payload is photos, video and
 * voice notes, all already entropy-coded. Deflating them costs time and
 * saves nothing. The transcript is the only compressible member and it is
 * kilobytes.
 *
 * Written out rather than taken from a dependency because the format is
 * small and fully specified (PKWARE APPNOTE §4.3), and every field below is
 * one the reader checks -- a wrong CRC or a wrong offset produces a file
 * that looks fine until someone tries to open it.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const METHOD_STORED = 0;
/** Bit 11: the name is UTF-8. Without it a reader is entitled to interpret
 * non-ASCII names as code page 437, which mangles every name that is not
 * plain English. */
const FLAG_UTF8 = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, which is what ZIP stores. Two-second resolution and
 * no timezone -- the format simply cannot hold more, so the local wall clock
 * is the honest thing to write. */
export function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Strips anything that would make an archive unpack outside its own folder,
 * or produce a name a filesystem refuses. */
export function safeEntryName(name) {
  const cleaned = name
    .replace(/\\/g, "/")
    // Leading slashes and `..` segments are the zip-slip shape: an entry
    // named `../../x` unpacks over whatever is two levels up.
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
    .replace(/[\x00-\x1f<>:"|?*]/g, "_");
  return cleaned || "unnamed";
}

/**
 * @param {{name: string, bytes: Uint8Array, date?: Date}[]} entries
 * @returns {Uint8Array} the complete archive
 */
export function buildZip(entries) {
  const encoder = new TextEncoder();
  const prepared = [];
  let offset = 0;
  const chunks = [];

  const names = new Set();
  for (const entry of entries) {
    let name = safeEntryName(entry.name);
    // Two entries with one name is legal in the format and confusing
    // everywhere else; readers disagree about which one wins.
    if (names.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let n = 2;
      while (names.has(`${stem} (${n})${ext}`)) n += 1;
      name = `${stem} (${n})${ext}`;
    }
    names.add(name);

    const nameBytes = encoder.encode(name);
    const crc = crc32(entry.bytes);
    const { time, date } = dosDateTime(entry.date ?? new Date());

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    lv.setUint16(4, VERSION_NEEDED, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, METHOD_STORED, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.bytes.length, true);
    lv.setUint32(22, entry.bytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, entry.bytes);
    prepared.push({ nameBytes, crc, size: entry.bytes.length, time, date, offset });
    offset += local.length + entry.bytes.length;
  }

  const centralStart = offset;
  for (const item of prepared) {
    const central = new Uint8Array(46 + item.nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    cv.setUint16(4, VERSION_NEEDED, true);
    cv.setUint16(6, VERSION_NEEDED, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, METHOD_STORED, true);
    cv.setUint16(12, item.time, true);
    cv.setUint16(14, item.date, true);
    cv.setUint32(16, item.crc, true);
    cv.setUint32(20, item.size, true);
    cv.setUint32(24, item.size, true);
    cv.setUint16(28, item.nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, item.offset, true);
    central.set(item.nameBytes, 46);
    chunks.push(central);
    offset += central.length;
  }

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_OF_CENTRAL_SIGNATURE, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, prepared.length, true);
  ev.setUint16(10, prepared.length, true);
  ev.setUint32(12, offset - centralStart, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);
  chunks.push(end);

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
