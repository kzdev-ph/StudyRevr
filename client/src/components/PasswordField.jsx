// A password box. With `onToggle`, a Show / Hide button (44 px) sits beside it.
export default function PasswordField({ id, label, value, onChange, shown = false, onToggle, autoComplete, describedBy, invalid }) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="field__row">
        <input
          id={id}
          className="field__input"
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={describedBy}
          aria-invalid={invalid ? true : undefined}
        />
        {onToggle && (
          <button type="button" className="btn btn--quiet field__reveal" onClick={onToggle} aria-controls={id} aria-pressed={shown}>
            {shown ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
    </div>
  );
}
