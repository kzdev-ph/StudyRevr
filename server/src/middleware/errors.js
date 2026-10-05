import multer from 'multer';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function notFound(_req, _res, next) {
  next(new HttpError(404, 'Not found.'));
}

// Always answers with JSON { error: { message } } and never leaks stack traces.
export function errorHandler(maxUploadBytes) {
  // eslint-disable-next-line no-unused-vars
  return (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { message: err.message, ...err.extra } });
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(maxUploadBytes / 1024 / 1024);
        return res.status(413).json({ error: { message: `That file is larger than ${mb} MB. Upload a smaller file.` } });
      }
      return res.status(400).json({ error: { message: 'Upload one file in the "file" field.' } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { message: 'Request body is not valid JSON.' } });
    }
    console.error(err);
    return res.status(500).json({ error: { message: 'Something went wrong on the server.' } });
  };
}
