import path from 'node:path';
import multer from 'multer';
import { HttpError } from './errors.js';

const ALLOWED = {
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
};
// Browsers and OSes sometimes send these for valid OOXML files.
const GENERIC_MIME = ['application/octet-stream', 'application/zip', 'application/x-zip-compressed', ''];
const LEGACY = new Set(['.doc', '.ppt']);

export const fileExtension = (filename) => path.extname(filename || '').toLowerCase();

function fileFilter(_req, file, cb) {
  const ext = fileExtension(file.originalname);
  if (LEGACY.has(ext)) {
    return cb(new HttpError(400, `Old ${ext} files aren't supported. Open it and save as ${ext}x, then upload again.`));
  }
  if (!ALLOWED[ext]) {
    return cb(new HttpError(400, 'Only .docx and .pptx files can be uploaded.'));
  }
  const mime = (file.mimetype || '').toLowerCase();
  if (!ALLOWED[ext].includes(mime) && !GENERIC_MIME.includes(mime)) {
    return cb(new HttpError(400, `This file's type (${mime}) doesn't match ${ext}. Upload a real ${ext} file.`));
  }
  cb(null, true);
}

export function createUpload(maxUploadBytes) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: 1 },
    fileFilter,
  }).single('file');
}

// .docx/.pptx are zip archives; a renamed text file or image fails here.
export function assertZip(buffer) {
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  if (!isZip) throw new HttpError(400, "This file isn't a valid .docx/.pptx (it may be renamed or corrupted).");
}
