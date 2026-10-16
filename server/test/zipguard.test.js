import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { createApp } from '../src/app.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { extractText } from '../src/services/extract.js';
import { assertSafeZip, MAX_UNCOMPRESSED_BYTES } from '../src/services/zipguard.js';
import { studyFetch, TEST_PIN } from './helpers.js';

const fetch = studyFetch; // as participant P00, with the admin PIN (see helpers.js)

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const zipOf = async (files) => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
};

// Rewrites the declared uncompressed size of every central-directory entry (a lying header, no real data needed).
function declareUncompressedSize(buffer, size) {
  const out = Buffer.from(buffer);
  for (let pos = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); pos !== -1; pos = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), pos + 4)) {
    out.writeUInt32LE(size, pos + 24);
  }
  return out;
}

// Hand-built single-entry zip64 archive; the entry's real sizes live in the 0x0001 extra field.
function makeZip64(name, content, declaredSize = content.length) {
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const localPart = Buffer.concat([local, nameBuf, content]);

  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(declaredSize), 4);
  extra.writeBigUInt64LE(BigInt(content.length), 12);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(45, 4);
  cd.writeUInt16LE(45, 6);
  cd.writeUInt32LE(content.length, 16);
  cd.writeUInt32LE(0xffffffff, 20);
  cd.writeUInt32LE(0xffffffff, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(extra.length, 30);
  const cdPart = Buffer.concat([cd, nameBuf, extra]);

  const cdOffset = localPart.length;
  const z64Eocd = Buffer.alloc(56);
  z64Eocd.writeUInt32LE(0x06064b50, 0);
  z64Eocd.writeBigUInt64LE(44n, 4);
  z64Eocd.writeBigUInt64LE(1n, 24);
  z64Eocd.writeBigUInt64LE(1n, 32);
  z64Eocd.writeBigUInt64LE(BigInt(cdPart.length), 40);
  z64Eocd.writeBigUInt64LE(BigInt(cdOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(cdOffset + cdPart.length), 8);
  locator.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([localPart, cdPart, z64Eocd, locator, eocd]);
}

const rejects422 = (fn, pattern) =>
  assert.throws(fn, (err) => err.status === 422 && pattern.test(err.message), `expected a 422 matching ${pattern}`);

describe('assertSafeZip', () => {
  it('accepts a normal archive and reports its size', async () => {
    const buf = await zipOf({ 'a.txt': 'hello', 'b.txt': 'world!' });
    const { names, ...size } = assertSafeZip(buf);
    assert.deepEqual(size, { entries: 2, uncompressedBytes: 11 });
    assert.deepEqual([...names], ['a.txt', 'b.txt']);
  });

  it('rejects an archive whose total uncompressed size exceeds the limit (real data, tiny limit)', async () => {
    const buf = await zipOf({ 'zeros.bin': Buffer.alloc(3 * 1024 * 1024) });
    assert.ok(buf.length < 20 * 1024, `compressed size was ${buf.length}`);
    rejects422(() => assertSafeZip(buf, { maxUncompressedBytes: 1024 * 1024 }), /more than 1 MB once unpacked/);
  });

  it('adds up entries: many small files can exceed the limit together', async () => {
    const buf = await zipOf({ 'a.bin': Buffer.alloc(600 * 1024), 'b.bin': Buffer.alloc(600 * 1024) });
    rejects422(() => assertSafeZip(buf, { maxUncompressedBytes: 1024 * 1024 }), /once unpacked/);
  });

  it('rejects a header that declares more than the default 200 MB without inflating anything', async () => {
    assert.equal(MAX_UNCOMPRESSED_BYTES, 200 * 1024 * 1024);
    const buf = declareUncompressedSize(await zipOf({ 'word/document.xml': 'x' }), 0xf0000000);
    rejects422(() => assertSafeZip(buf), /more than 200 MB once unpacked/);
  });

  it('allows a total just under the default limit', async () => {
    const buf = declareUncompressedSize(await zipOf({ 'a.xml': 'x', 'b.xml': 'x' }), 99 * 1024 * 1024);
    assert.equal(assertSafeZip(buf).uncompressedBytes, 198 * 1024 * 1024);
  });

  it('rejects an archive with an unreasonable number of entries', async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, 'x']));
    const buf = await zipOf(files);
    assert.equal(assertSafeZip(buf, { maxEntries: 30 }).entries, 30);
    rejects422(() => assertSafeZip(buf, { maxEntries: 29 }), /too many parts/);
  });

  it('counts entries by walking the directory, not by trusting the header count', async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, 'x']));
    const buf = await zipOf(files);
    buf.writeUInt16LE(1, buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 10); // header now claims 1 entry
    rejects422(() => assertSafeZip(buf, { maxEntries: 10 }), /too many parts/);
  });

  it('reads zip64 archives: accepts real small sizes, rejects a declared 5 GB entry', () => {
    const ok = makeZip64('word/document.xml', Buffer.from('<w:document/>'));
    const { names, ...size } = assertSafeZip(ok);
    assert.deepEqual(size, { entries: 1, uncompressedBytes: 13 });
    assert.ok(names.has('word/document.xml'));
    rejects422(() => assertSafeZip(makeZip64('bomb.bin', Buffer.from('x'), 5 * 1024 ** 3)), /once unpacked/);
  });

  it('rejects data that is not a zip at all', () => {
    rejects422(() => assertSafeZip(Buffer.from('this is not a zip archive, just some text '.repeat(5))), /corrupted/);
  });
});

describe('zip-bomb guard in the upload pipeline', () => {
  let db;
  let server;
  let base;

  before(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    const app = createApp(db, { maxUploadBytes: 5 * 1024 * 1024, adminPin: TEST_PIN }, { runner: { enqueue() {} } });
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const upload = (buffer, name, mime) => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), name);
    return fetch(`${base}/api/lessons`, { method: 'POST', body: form });
  };

  it('refuses an oversized .docx before parsing and stores no lesson', async () => {
    const bomb = declareUncompressedSize(await zipOf({ '[Content_Types].xml': '<x/>', 'word/document.xml': '<x/>' }), 0x40000000);
    const res = await upload(bomb, 'bomb.docx', DOCX_MIME);
    assert.equal(res.status, 422);
    assert.match((await res.json()).error.message, /more than 200 MB once unpacked/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lessons').get().c, 0);
  });

  it('refuses an oversized .pptx too', async () => {
    const pptx = new PptxGenJS();
    pptx.addSlide().addText('Hello', { x: 1, y: 1 });
    const bomb = declareUncompressedSize(await pptx.write({ outputType: 'nodebuffer' }), 0x40000000);
    await assert.rejects(extractText(bomb, '.pptx'), (err) => err.status === 422 && /once unpacked/.test(err.message));
  });

  it('still accepts a normal pptx', async () => {
    const pptx = new PptxGenJS();
    pptx.addSlide().addText('Hello world', { x: 1, y: 1 });
    const { text } = await extractText(await pptx.write({ outputType: 'nodebuffer' }), '.pptx');
    assert.match(text, /Hello world/);
  });
});
