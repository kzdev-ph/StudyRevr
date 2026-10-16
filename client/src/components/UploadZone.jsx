import { useRef, useState } from 'react';
import { UploadIcon } from './Icons.jsx';

const ACCEPT = '.docx,.pptx,.pdf';

// Drag a file in or pick one. It only hands the chosen file to `onFile`; the server decides what is acceptable
// (type, size, safety) and its message is shown by the caller. A student's version (`compact`) is smaller, says how
// many uploads are left (`note`) and can be turned off for the day (`disabled`).
export default function UploadZone({ onFile, onReject, busy, empty, compact = false, disabled = false, title, text, note }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const off = busy || disabled;

  const take = (files) => {
    if (!files?.length) return;
    if (files.length > 1) return onReject('Upload one lesson at a time. Choose a single file.');
    onFile(files[0]);
  };

  return (
    <div
      className={`upload${over ? ' upload--over' : ''}${empty ? ' upload--empty' : ''}${compact ? ' upload--compact' : ''}`}
      onDragOver={(e) => { e.preventDefault(); if (!off) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!off) take(e.dataTransfer.files);
      }}
    >
      <UploadIcon size={30} className="upload__icon" />
      <div className="upload__text">
        <h2 className="upload__title">{title ?? (empty ? 'Add your first lesson' : 'Add a lesson')}</h2>
        <p>{text ?? 'Drop a .docx, .pptx or .pdf file here, or choose one from your device.'}</p>
        {note && (
          <p className="upload__note" aria-live="polite">
            {note}
          </p>
        )}
      </div>
      <button type="button" className="btn btn--primary" disabled={off} onClick={() => input.current?.click()}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" /> Uploading…
          </>
        ) : (
          'Choose file'
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          take(e.target.files);
          e.target.value = ''; // picking the same file again should still fire
        }}
      />
    </div>
  );
}
