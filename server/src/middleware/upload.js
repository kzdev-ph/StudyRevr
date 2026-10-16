import path from 'node:path';
import multer from 'multer';
import { HttpError } from './errors.js';

const ALLOWED = {
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.pdf': ['application/pdf'],
};
// Browsers and OSes sometimes send these for valid OOXML files.
const GENERIC_MIME = ['application/octet-stream', 'application/zip', 'application/x-zip-compressed', ''];
const LEGACY = new Set(['.doc', '.ppt']);

export const fileExtension = (filename) => path.extname(filename || '').toLowerCase();

function fileFilter(_req, file, cb) {
  const ext = fileExtension(file.originalname);
  if (LEGACY.has(ext)) {
    return cb(new HttpError(400, `Old ${ext} files aren't supported. Open it and save as ${ext}x, then upload again.`, { code: 'wrong_type' }));
  }
  if (!ALLOWED[ext]) {
    return cb(new HttpError(400, 'Only .docx, .pptx and .pdf files can be uploaded.', { code: 'wrong_type' }));
  }
  const mime = (file.mimetype || '').toLowerCase();
  if (!ALLOWED[ext].includes(mime) && !GENERIC_MIME.includes(mime)) {
    return cb(new HttpError(400, `This file's type (${mime}) doesn't match ${ext}. Upload a real ${ext} file.`, { code: 'wrong_type' }));
  }
  cb(null, true);
}

export function createUpload(maxUploadBytes) {
  return multer({
    storage: multer.memoryStorage(),
    // one file, a title and nothing else: a form with more parts, fields or headers is refused before it is buffered
    limits: { fileSize: maxUploadBytes, files: 1, fields: 2, fieldSize: 1024, fieldNameSize: 100, parts: 3, headerPairs: 20 },
    fileFilter,
  }).single('file');
}

const startsWith = (buffer, bytes) => buffer.length > bytes.length && bytes.every((b, i) => buffer[i] === b);

// .docx/.pptx are zip archives ("PK\x03\x04"); .pdf starts with "%PDF". A renamed text file or image fails here.
export function assertSignature(buffer, ext) {
  const ok = ext === '.pdf' ? startsWith(buffer, [0x25, 0x50, 0x44, 0x46]) : startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]);
  if (!ok) throw new HttpError(400, `This file isn't a valid ${ext} (it may be renamed or corrupted).`, { code: 'bad_signature' });
}
