import { HttpError } from '../middleware/errors.js';

// A .docx/.pptx is a zip. A "zip bomb" is a small upload that inflates to gigabytes (or millions of entries) and
// exhausts memory when we unpack it. We read the central directory (sizes are declared there, nothing is inflated)
// and reject before any parser touches the file. JSZip and mammoth also verify each entry's real size against the
// declared one while inflating, so a header that understates the size is caught by the parser, not trusted.
export const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
// A 500-slide deck with media is a few thousand entries; real Office files stay far below this.
export const MAX_ZIP_ENTRIES = 10_000;

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_ENTRY_SIG = 0x02014b50;
const MAX_COMMENT = 0xffff;

const CORRUPT = "This file looks corrupted (its zip structure can't be read). Re-save it and try again.";
const mb = (bytes) => Math.round(bytes / 1024 / 1024);

const u64 = (buf, pos) => {
  const n = buf.readBigUInt64LE(pos);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(422, CORRUPT);
  return Number(n);
};

function findEndOfCentralDirectory(buf) {
  const lowest = Math.max(0, buf.length - 22 - MAX_COMMENT);
  for (let pos = buf.length - 22; pos >= lowest; pos--) {
    if (buf.readUInt32LE(pos) === EOCD_SIG) return pos;
  }
  throw new HttpError(422, CORRUPT);
}

// Where the central directory starts and how many entries it claims to hold (zip64 aware).
function locateCentralDirectory(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  let entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || offset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== ZIP64_LOCATOR_SIG) throw new HttpError(422, CORRUPT);
    const z64 = u64(buf, loc + 8);
    if (z64 + 56 > buf.length || buf.readUInt32LE(z64) !== ZIP64_EOCD_SIG) throw new HttpError(422, CORRUPT);
    entries = u64(buf, z64 + 32);
    offset = u64(buf, z64 + 48);
  }
  return { entries, offset };
}

// A zip64 entry stores real sizes in extra field 0x0001, in the order: uncompressed, compressed (each only
// present when its 32-bit slot is 0xFFFFFFFF).
function zip64UncompressedSize(buf, extraStart, extraEnd) {
  for (let pos = extraStart; pos + 4 <= extraEnd; ) {
    const id = buf.readUInt16LE(pos);
    const size = buf.readUInt16LE(pos + 2);
    if (id === 0x0001 && size >= 8 && pos + 12 <= extraEnd) return u64(buf, pos + 4);
    pos += 4 + size;
  }
  throw new HttpError(422, CORRUPT);
}

// Throws an HttpError(422) when the archive is too big once unpacked, holds too many entries, or can't be read.
export function assertSafeZip(buffer, { maxUncompressedBytes = MAX_UNCOMPRESSED_BYTES, maxEntries = MAX_ZIP_ENTRIES } = {}) {
  const tooMany = () =>
    new HttpError(422, `This file contains too many parts (over ${maxEntries.toLocaleString('en-US')}) to be a normal document, so it can't be processed.`);
  const tooBig = () =>
    new HttpError(422, `This file expands to more than ${mb(maxUncompressedBytes)} MB once unpacked, so it can't be processed.`);

  let declared;
  let pos;
  try {
    ({ entries: declared, offset: pos } = locateCentralDirectory(buffer));
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(422, CORRUPT);
  }
  if (declared > maxEntries) throw tooMany();

  let total = 0;
  let seen = 0;
  try {
    while (pos + 46 <= buffer.length && buffer.readUInt32LE(pos) === CENTRAL_ENTRY_SIG) {
      if (++seen > maxEntries) throw tooMany(); // the header can understate the count; the walk can't
      let size = buffer.readUInt32LE(pos + 24);
      const nameLen = buffer.readUInt16LE(pos + 28);
      const extraLen = buffer.readUInt16LE(pos + 30);
      const commentLen = buffer.readUInt16LE(pos + 32);
      const extraStart = pos + 46 + nameLen;
      if (size === 0xffffffff) size = zip64UncompressedSize(buffer, extraStart, extraStart + extraLen);
      total += size;
      if (total > maxUncompressedBytes) throw tooBig();
      pos = extraStart + extraLen + commentLen;
    }
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(422, CORRUPT);
  }
  return { entries: seen, uncompressedBytes: total };
}
