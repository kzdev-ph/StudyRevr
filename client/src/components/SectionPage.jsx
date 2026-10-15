import { useEffect, useRef, useState } from 'react';
import Notice from './Notice.jsx';
import Prose from './Prose.jsx';
import QuickCheck from './QuickCheck.jsx';
import SourcePanel from './SourcePanel.jsx';
import { SimplerIcon, SourceIcon, TranslateIcon } from './Icons.jsx';

const WORKING = {
  simple: 'Rewriting this section in simpler words…',
  filipino: 'Translating this section to Filipino/Taglish…',
};

const RULES = 5;
const LONG_MS = 10_000; // after this the ruled lines stop moving and the page says it is still working

// While a rewrite is being made: ruled lines being written on, one after another (a slow loop that stops while it is
// off screen; blank rules with reduced motion).
function Skeleton({ label }) {
  const ref = useRef(null);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLong(true), LONG_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([entry]) => el.classList.toggle('is-off', !entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div className={`skeleton${long ? ' is-long' : ''}`} role="status" aria-live="polite" ref={ref}>
      <p className="skeleton__label">{label}</p>
      {long && <p className="muted">Still working…</p>}
      <div className="rules" aria-hidden="true">
        {Array.from({ length: RULES }, (_, k) => (
          <span key={k} className="rules__line">
            <span className="rules__ink" />
          </span>
        ))}
      </div>
    </div>
  );
}

// One section of the review. `variant` is 'summary' | 'simple' | 'filipino'; a rewrite is made on the first tap and
// then kept, so tapping the button again just shows it. The stored summary is never changed. `note`: a line under a
// rewrite that a fallback AI answered ("Your key didn't work, so the default AI answered.").
export default function SectionPage({ lesson, section, variant, busy, failure, note, showSource, focusTitle, onVariant, onRetry, onToggleSource }) {
  const title = useRef(null);
  useEffect(() => {
    if (focusTitle) title.current?.focus({ preventScroll: true });
  }, [focusTitle, section.id]);

  const simple = section.simple_version;
  const filipino = section.filipino_version;
  const showing = variant === 'simple' ? simple : variant === 'filipino' ? filipino : true;
  const heading = variant === 'filipino' && filipino?.title ? filipino.title : section.title;
  const questions = variant === 'filipino' && filipino?.check_questions?.length ? filipino.check_questions : section.check_questions;

  return (
    <div className="page">
      <div className="page__main">
        <h2 className="page__title" ref={title} tabIndex={-1}>
          {heading}
        </h2>

        <div className="tools" role="group" aria-label="Ways to read this section">
          <button type="button" className="chip-btn" aria-pressed={variant === 'simple'} onClick={() => onVariant('simple')}>
            <SimplerIcon size={18} /> Explain simpler
          </button>
          <button type="button" className="chip-btn" aria-pressed={variant === 'filipino'} onClick={() => onVariant('filipino')}>
            <TranslateIcon size={18} /> Filipino/Taglish
          </button>
          <button type="button" className="chip-btn" aria-pressed={showSource} onClick={onToggleSource}>
            <SourceIcon size={18} /> Original text
          </button>
        </div>

        {variant === 'summary' && <Prose text={section.content} />}

        {variant !== 'summary' && busy && <Skeleton label={WORKING[variant]} />}

        {variant !== 'summary' && !busy && failure && (
          <Notice
            action={
              <button type="button" className="btn btn--quiet btn--small" onClick={onRetry}>
                Try again
              </button>
            }
          >
            {failure}
          </Notice>
        )}

        {variant === 'simple' && !busy && simple && (
          <>
            <Prose text={simple.text} />
            {simple.example && (
              <aside className="example">
                <p className="example__label">
                  <span className="mk">An everyday way to picture it</span>
                </p>
                <Prose text={simple.example} />
              </aside>
            )}
          </>
        )}

        {variant === 'filipino' && !busy && filipino && <Prose text={filipino.content} />}

        {variant !== 'summary' && !busy && note && showing && <p className="muted fallback-note">{note}</p>}
      </div>

      {/* beside the reading column on a wide screen, under it on a phone */}
      <div className="page__aside">
        {showSource && <SourcePanel section={section} lesson={lesson} />}
        {showing && !busy && <QuickCheck key={section.id} questions={questions} />}
      </div>
    </div>
  );
}
