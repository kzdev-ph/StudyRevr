import { createInflateRaw } from 'node:zlib';
import { HttpError } from '../middleware/errors.js';

// A .docx/.pptx is a zip. A "zip bomb" is a small upload that inflates to gigabytes (or millions of entries) and
// exhausts memory when we unpack it. assertSafeZip reads the central directory (sizes are declared there, nothing is
// inflated) and rejects before any parser touches the file. But those sizes are only claims: a header can say 1 KB for
// an entry that inflates to a gigabyte, and JSZip / mammoth only compare the real size with the claim after they have
// inflated the whole entry. So assertEntrySizes then inflates every entry itself, as a stream that is thrown away and
// stopped one byte past the declared size, and the file is refused if any entry is not exactly its declared size.
export const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
// A 500-slide deck with media is a few thousand entries; real Office files stay far below this.
export const MAX_ZIP_ENTRIES = 10_000;

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_ENTRY_SIG = 0x02014b50;
const LOCAL_ENTRY_SIG = 0x04034b50;
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

// A zip64 entry stores real values in extra field 0x0001, in the order: uncompressed size, compressed size, local
// header offset (each only present when its 32-bit slot is 0xFFFFFFFF). `wanted` says which slots are 0xFFFFFFFF.
function zip64Values(buf, extraStart, extraEnd, wanted) {
  for (let pos = extraStart; pos + 4 <= extraEnd; ) {
    const id = buf.readUInt16LE(pos);
    const size = buf.readUInt16LE(pos + 2);
    if (id === 0x0001) {
      let at = pos + 4;
      const out = {};
      for (const key of ['size', 'compressedSize', 'offset']) {
        if (!wanted[key]) continue;
        if (at + 8 > pos + 4 + size || at + 8 > extraEnd) throw new HttpError(422, CORRUPT);
        out[key] = u64(buf, at);
        at += 8;
      }
      return out;
    }
    pos += 4 + size;
  }
  throw new HttpError(422, CORRUPT);
}

// Throws an HttpError(422) when the archive is too big once unpacked, holds too many entries, or can't be read.
// -> { entries, uncompressedBytes, names, records } (names: every entry's path, read from the central directory;
// records: each entry's declared size, where its data is and how it is stored, for assertEntrySizes)
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
  const names = new Set();
  const records = [];
  try {
    while (pos + 46 <= buffer.length && buffer.readUInt32LE(pos) === CENTRAL_ENTRY_SIG) {
      if (++seen > maxEntries) throw tooMany(); // the header can understate the count; the walk can't
      const method = buffer.readUInt16LE(pos + 10);
      let compressedSize = buffer.readUInt32LE(pos + 20);
      let size = buffer.readUInt32LE(pos + 24);
      let offset = buffer.readUInt32LE(pos + 42);
      const nameLen = buffer.readUInt16LE(pos + 28);
      const extraLen = buffer.readUInt16LE(pos + 30);
      const commentLen = buffer.readUInt16LE(pos + 32);
      const extraStart = pos + 46 + nameLen;
      const name = buffer.toString('utf8', pos + 46, extraStart);
      names.add(name);
      const wanted = { size: size === 0xffffffff, compressedSize: compressedSize === 0xffffffff, offset: offset === 0xffffffff };
      if (wanted.size || wanted.compressedSize || wanted.offset) {
        const real = zip64Values(buffer, extraStart, extraStart + extraLen, wanted);
        size = real.size ?? size;
        compressedSize = real.compressedSize ?? compressedSize;
        offset = real.offset ?? offset;
      }
      records.push({ name, method, size, compressedSize, offset });
      total += size;
      if (total > maxUncompressedBytes) throw tooBig();
      pos = extraStart + extraLen + commentLen;
    }
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(422, CORRUPT);
  }
  return { entries: seen, uncompressedBytes: total, names, records };
}

// How many bytes `data` inflates to, counting a chunk at a time and stopping once past `limit` (nothing is kept).
function inflatedLength(data, limit) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const inflater = createInflateRaw();
    inflater.on('data', (chunk) => {
      n += chunk.length;
      if (n > limit) {
        inflater.destroy();
        resolve(n);
      }
    });
    inflater.on('end', () => resolve(n));
    inflater.on('error', reject);
    inflater.end(data);
  });
}

// Inflates every entry of the archive (the `records` of assertSafeZip) to check it is really the size the directory
// says, never producing more than that plus one chunk. Throws HttpError(422) for an entry that is bigger or smaller than
// declared, stored in a way we don't read, or cut off. Async: a big, honest deck takes a moment, and the server keeps
// answering others meanwhile.
export async function assertEntrySizes(buffer, records) {
  for (const { method, size, compressedSize, offset } of records) {
    try {
      if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_ENTRY_SIG) throw new HttpError(422, CORRUPT);
      const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
      if (start + compressedSize > buffer.length) throw new HttpError(422, CORRUPT);
      const data = buffer.subarray(start, start + compressedSize);
      let real;
      if (method === 0) real = data.length;
      else if (method === 8) real = await inflatedLength(data, size);
      else throw new HttpError(422, CORRUPT);
      if (real !== size) throw new HttpError(422, CORRUPT);
    } catch (err) {
      throw err instanceof HttpError ? err : new HttpError(422, CORRUPT);
    }
  }
}
