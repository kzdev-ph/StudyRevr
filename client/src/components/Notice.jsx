import { AlertIcon } from './Icons.jsx';

// An inline message. `tone`: 'error' | 'warn'. Errors are announced to screen readers as they appear.
// `hint` is the developer hint the server sends with an error (e.g. which .env variable to set). It stays collapsed
// behind "Details" so the message itself stays plain.
// TODO(Phase 7): the server's hints point at .env; once Settings has the key / model fields they should point there.
export default function Notice({ tone = 'error', children, action, onDismiss, hint }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <AlertIcon className="notice__icon" size={20} />
      <div className="notice__body">
        {children}
        {hint && (
          <details className="details">
            <summary>Details</summary>
            <p className="details__text">{hint}</p>
          </details>
        )}
      </div>
      {action}
      {onDismiss && (
        <button type="button" className="notice__close" onClick={onDismiss} aria-label="Dismiss">
          Dismiss
        </button>
      )}
    </div>
  );
}
