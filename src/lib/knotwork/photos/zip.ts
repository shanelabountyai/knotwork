// A zip archive, written here (D-67: no dependency). PURE. Stored entries only (method 0, no compression): the
// photos are JPEGs already. Classic format: no zip64, so at most 65,535 entries and 4 GB; more is refused.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3), as zip and PNG use it. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipFile = { name: string; data: Uint8Array };
export type ZipTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const utf8 = (s: string) => new TextEncoder().encode(s);

/** The archive's bytes. Every entry carries the same timestamp (`at`): the moment of the download, passed in. */
export function zipStored(files: readonly ZipFile[], at: ZipTime): Uint8Array {
  if (files.length > 0xffff) throw new RangeError('zip: more than 65,535 files');
  if (new Set(files.map((f) => f.name)).size !== files.length) throw new RangeError('zip: two files with the same name');
  const time = (at.hour << 11) | (at.minute << 5) | (at.second >> 1);
  const date = ((Math.max(at.year, 1980) - 1980) << 9) | (at.month << 5) | at.day;
  const names = files.map((f) => utf8(f.name));
  const size = files.reduce((n, f, i) => n + 30 + names[i]!.length + f.data.length + 46 + names[i]!.length, 22);
  if (size > 0xffffffff) throw new RangeError('zip: more than 4 GB');
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let p = 0;
  const w16 = (v: number) => (view.setUint16(p, v, true), (p += 2));
  const w32 = (v: number) => (view.setUint32(p, v >>> 0, true), (p += 4));
  const bytes = (b: Uint8Array) => (out.set(b, p), (p += b.length));
  const entries = files.map((f, i) => {
    const offset = p;
    const crc = crc32(f.data);
    w32(0x04034b50); w16(20); w16(0x0800); w16(0); w16(time); w16(date); w32(crc); w32(f.data.length); w32(f.data.length); w16(names[i]!.length); w16(0);
    bytes(names[i]!);
    bytes(f.data);
    return { offset, crc };
  });
  const start = p;
  files.forEach((f, i) => {
    w32(0x02014b50); w16(20); w16(20); w16(0x0800); w16(0); w16(time); w16(date); w32(entries[i]!.crc); w32(f.data.length); w32(f.data.length);
    w16(names[i]!.length); w16(0); w16(0); w16(0); w16(0); w32(0); w32(entries[i]!.offset);
    bytes(names[i]!);
  });
  const end = p;
  w32(0x06054b50); w16(0); w16(0); w16(files.length); w16(files.length); w32(end - start); w32(start); w16(0);
  return out;
}
