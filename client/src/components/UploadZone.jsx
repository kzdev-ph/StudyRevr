import { useRef, useState } from 'react';
import { UploadIcon } from './Icons.jsx';

const ACCEPT = '.docx,.pptx,.pdf';

// Drag a file in or pick one. It only hands the chosen file to `onFile`; the server decides what is acceptable
// (type, size, safety) and its message is shown by the caller.
export default function UploadZone({ onFile, onReject, busy, empty, compact }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);

  const take = (files) => {
    if (!files?.length) return;
    if (files.length > 1) return onReject('Upload one lesson at a time. Choose a single file.');
    onFile(files[0]);
  };

  return (
    <div
      className={`upload${over ? ' upload--over' : ''}${empty ? ' upload--empty' : compact ? ' upload--compact' : ''}`}
      onDragOver={(e) => { e.preventDefault(); if (!busy) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!busy) take(e.dataTransfer.files);
      }}
    >
      <UploadIcon size={empty ? 30 : 24} className="upload__icon" />
      <div className="upload__text">
        <h2 className="upload__title">{empty ? 'Add your first lesson' : 'Add a lesson'}</h2>
        {empty || !compact ? (
          <p>Choose a .docx, .pptx or .pdf file. On a computer you can also drop it here.</p>
        ) : (
          <p className="visually-hidden">Choose or drop a .docx, .pptx or .pdf file.</p>
        )}
      </div>
      <button type="button" className={`btn ${compact && !empty ? 'btn--quiet' : 'btn--primary'}`} disabled={busy} onClick={() => input.current?.click()}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" /> Uploading…
          </>
        ) : (
          compact && !empty ? 'Upload' : 'Choose a file'
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
