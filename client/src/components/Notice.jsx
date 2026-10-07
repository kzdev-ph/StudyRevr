import { AlertIcon, InfoIcon } from './Icons.jsx';

// An inline message. `tone`: 'error' | 'warn' | 'info' (a neutral fact, such as picking up a quiz where you left off).
// Errors are announced to screen readers as they appear.
export default function Notice({ tone = 'error', children, action, onDismiss }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'info' ? <InfoIcon className="notice__icon" size={20} /> : <AlertIcon className="notice__icon" size={20} />}
      <div className="notice__body">{children}</div>
      {action}
      {onDismiss && (
        <button type="button" className="notice__close" onClick={onDismiss} aria-label="Dismiss">
          Dismiss
        </button>
      )}
    </div>
  );
}
